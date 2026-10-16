// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {OnsetDetector,analyseSpectrum,createDemoVoice,placeImpulse,voiceSignal} from './lib/voice-signal';

const sine=(hz:number,rate:number,n:number,amp:number)=>Uint8Array.from({length:n},(_,i)=>128+Math.round(Math.sin(2*Math.PI*hz*i/rate)*127*amp));
const spectrumAt=(hz:number,rate:number,bins:number)=>{const f=new Uint8Array(bins);f[Math.round(hz/(rate/(bins*2)))]=250;return f;};

afterEach(()=>{voiceSignal.detachAll();delete (window as unknown as {AudioContext?:unknown}).AudioContext;});

it('measures level from the waveform and pitch from the spectrum',()=>{
 const quiet=analyseSpectrum(sine(200,48000,512,.05),spectrumAt(200,48000,256),48000);
 const loud=analyseSpectrum(sine(200,48000,512,.8),spectrumAt(200,48000,256),48000);
 expect(loud.level).toBeGreaterThan(quiet.level*8);
 const low=analyseSpectrum(sine(150,48000,512,.5),spectrumAt(150,48000,256),48000);
 const high=analyseSpectrum(sine(2500,48000,512,.5),spectrumAt(2500,48000,256),48000);
 expect(high.centroid).toBeGreaterThan(low.centroid+.4);
 for(const v of [low,high,quiet]){expect(v.centroid).toBeGreaterThanOrEqual(0);expect(v.centroid).toBeLessThanOrEqual(1);}
 const silent=analyseSpectrum(new Uint8Array(512).fill(128),new Uint8Array(256),48000);
 expect(silent.level).toBe(0);expect(Number.isFinite(silent.centroid)).toBe(true);
});
it('fires on speech onsets only, with a cooldown, and ignores steady noise',()=>{
 const d=new OnsetDetector(140);let fired=0,t=0;
 for(let i=0;i<120;i++,t+=16)d.update(.02,t);            // quiet room
 expect(fired).toBe(0);
 const first=d.update(.3,t);t+=16;expect(first).toBeGreaterThan(0);
 expect(d.update(.32,t)).toBe(0);                          // cooldown
 for(let i=0;i<40;i++,t+=16)if(d.update(.3,t)>0)fired++;   // sustained loudness is not a new onset every frame
 expect(fired).toBeLessThanOrEqual(1);
 const steady=new OnsetDetector();let n=0;for(let i=0;i<300;i++)if(steady.update(.2,i*16)>0)n++;
 expect(n).toBeLessThanOrEqual(2);
});
it('places the AI in the upper band, the broadcaster in the lower band, and pitch along x',()=>{
 for(let i=0;i<50;i++){
  const ai=placeImpulse('ai',i/50,.7,i*37),mic=placeImpulse('mic',i/50,.7,i*37);
  expect(ai.y).toBeLessThan(.5);expect(mic.y).toBeGreaterThan(.5);
  for(const p of [ai,mic]){expect(p.x).toBeGreaterThanOrEqual(.06);expect(p.x).toBeLessThanOrEqual(.94);}
 }
 expect(placeImpulse('mic',1,.5,0).x).toBeGreaterThan(placeImpulse('mic',0,.5,0).x);
});
it('does nothing, and never throws, when there is no call or no Web Audio',()=>{
 expect(voiceSignal.connected).toBe(false);
 expect(voiceSignal.poll(1)).toMatchObject({connected:false,impulses:[]});
 expect(()=>voiceSignal.attach('mic',{getAudioTracks:()=>[{}]} as unknown as MediaStream)).not.toThrow();
 expect(voiceSignal.connected).toBe(false);
});
it('taps streams with analysers that are never connected to an output',()=>{
 const connects:string[]=[];let closed=false;
 class FakeAnalyser{fftSize=0;smoothingTimeConstant=0;frequencyBinCount=256;connect(){connects.push('analyser->?');}disconnect(){}getByteTimeDomainData(a:Uint8Array){a.fill(128+90);}getByteFrequencyData(a:Uint8Array){a.fill(10);}}
 class FakeSource{connect(target:unknown){connects.push(target instanceof FakeAnalyser?'source->analyser':'source->OTHER');}disconnect(){}}
 class FakeContext{sampleRate=48000;destination={};createMediaStreamSource(){return new FakeSource();}createAnalyser(){return new FakeAnalyser();}resume(){return Promise.resolve();}close(){closed=true;return Promise.resolve();}}
 Object.defineProperty(window,'AudioContext',{value:FakeContext,configurable:true,writable:true});
 const stream={getAudioTracks:()=>[{}]} as unknown as MediaStream;
 voiceSignal.attach('mic',stream);voiceSignal.attach('ai',stream);
 expect(voiceSignal.connected).toBe(true);
 expect(connects).toEqual(['source->analyser','source->analyser']);   // nothing reaches the destination
 const frame=voiceSignal.poll(1000);
 expect(frame.connected).toBe(true);expect(frame.mic).toBeGreaterThan(0);expect(frame.ai).toBeGreaterThan(0);
 expect(voiceSignal.poll(1000)).toBe(frame);                           // one sample per frame
 voiceSignal.detachAll();expect(voiceSignal.connected).toBe(false);expect(closed).toBe(true);
 expect(voiceSignal.poll(2000).impulses).toEqual([]);
});
it('the preview demo alternates roles and produces valid impulses',()=>{
 const demo=createDemoVoice(),roles=new Set<string>();
 for(let t=0;t<20000;t+=16)for(const i of demo(t).impulses){roles.add(i.role);expect(i.strength).toBeGreaterThan(0);expect(i.strength).toBeLessThanOrEqual(1);}
 expect([...roles].sort()).toEqual(['ai','mic']);
});
it('a panel releasing its own call never cuts another panel\'s live call',()=>{
 class A{fftSize=0;smoothingTimeConstant=0;frequencyBinCount=8;connect(){}disconnect(){}getByteTimeDomainData(a:Uint8Array){a.fill(200);}getByteFrequencyData(a:Uint8Array){a.fill(5);}}
 class S{connect(){}disconnect(){}}
 let closed=0;
 class C{sampleRate=48000;createMediaStreamSource(){return new S();}createAnalyser(){return new A();}resume(){return Promise.resolve();}close(){closed++;return Promise.resolve();}}
 Object.defineProperty(window,'AudioContext',{value:C,configurable:true,writable:true});
 const stream={getAudioTracks:()=>[{}]} as unknown as MediaStream;
 voiceSignal.attach('mic',stream,'global-panel');voiceSignal.attach('ai',stream,'global-panel');
 voiceSignal.release('idle-session-panel');                 // an unrelated panel unmounting
 expect(voiceSignal.connected).toBe(true);expect(closed).toBe(0);
 voiceSignal.release('global-panel');                        // the owner ending its call
 expect(voiceSignal.connected).toBe(false);expect(closed).toBe(1);
 voiceSignal.attach('mic',stream,'session-panel');          // session voice links the same way
 expect(voiceSignal.connected).toBe(true);
});
import {computeBands} from './lib/voice-signal';
it('log-spaced bands separate low and high pitch and stay within 0..1',()=>{
 const rate=48000,bins=256,at=(hz:number)=>{const f=new Uint8Array(bins);const i=Math.round(hz/(rate/(bins*2)));f[i]=255;f[i-1]=200;f[i+1]=200;return f;};
 const out=new Float32Array(48),peak=(a:Float32Array)=>a.indexOf(Math.max(...a));
 const low=peak(computeBands(at(200),rate,out)),high=peak(computeBands(at(3000),rate,out));
 expect(high).toBeGreaterThan(low+15);
 for(const v of computeBands(at(1000),rate,out)){expect(v).toBeGreaterThanOrEqual(0);expect(v).toBeLessThanOrEqual(1);}
 expect(Math.max(...computeBands(new Uint8Array(bins),rate,out))).toBe(0);
});
