import {expect,it} from 'vitest';
import {curlFlow,Fluid,MatrixRain,ParticleField} from './lib/buzhoushan-effects';
const seeded=()=>{let s=12345;return()=>((s=(s*1664525+1013904223)>>>0)/4294967296);};

it('curl flow is divergence-free (finite differences)',()=>{
 const e=1e-4;
 for(const [u,v,t] of [[.2,.3,0],[.7,.1,5],[.5,.9,11]]){
  const dudx=(curlFlow(u+e,v,t)[0]-curlFlow(u-e,v,t)[0])/(2*e),dvdy=(curlFlow(u,v+e,t)[1]-curlFlow(u,v-e,t)[1])/(2*e);
  expect(Math.abs(dudx+dvdy)).toBeLessThan(1e-3);
 }
});
it('keeps 40k particles finite and inside the buffer, even with a pointer',()=>{
 const f=new ParticleField(40000,320,180,seeded());
 for(let i=0;i<120;i++)f.step(1/60,i/60,i%2===0,{x:.5,y:.5,active:true});
 for(let i=0;i<f.n;i+=97){
  expect(Number.isFinite(f.x[i])&&Number.isFinite(f.vx[i])).toBe(true);
  expect(f.x[i]).toBeGreaterThanOrEqual(0);expect(f.x[i]).toBeLessThan(320);
  expect(f.y[i]).toBeGreaterThanOrEqual(0);expect(f.y[i]).toBeLessThan(180);
 }
 const data=new Uint8ClampedArray(320*180*4);f.render(data,1/60,false);
 expect(data.some(v=>v>0)).toBe(true);
});
it('pointer repels nearby particles',()=>{
 const f=new ParticleField(1,200,200,()=>.5);f.x[0]=105;f.y[0]=100;f.vx[0]=0;f.vy[0]=0;f.life[0]=9;
 f.step(1/60,0,false,{x:.5,y:.5,active:true});
 expect(f.vx[0]).toBeGreaterThan(0);
});
it('pressure projection removes divergence and the solver stays stable',()=>{
 const fl=new Fluid(64,36);
 for(let k=0;k<fl.u.length;k++){fl.u[k]=Math.sin(k*.37)*20;fl.v[k]=Math.cos(k*.21)*20;}
 const before=fl.divergence();fl.project(60);
 expect(fl.divergence()).toBeLessThan(before*.35);
 for(let i=0;i<200;i++){fl.splat(.5+.3*Math.sin(i/9),.5,Math.cos(i/9)*60,30,[.3,.2,.5]);fl.step(.033);}
 expect(fl.u.every(Number.isFinite)&&fl.dye[0].every(Number.isFinite)).toBe(true);
 expect(Math.max(...fl.dye[0])).toBeGreaterThan(0);expect(Math.max(...fl.dye[0])).toBeLessThan(50);
});
it('matrix rain resets columns that leave the screen',()=>{
 const m=new MatrixRain(16,seeded());m.resize(160,160);
 expect(m.cols).toBe(10);
 const calls:string[]=[];
 const ctx={fillRect(){},fillText(_g:string,_x:number,_y:number){calls.push('t');},set fillStyle(_v:string){},set font(_v:string){},set textBaseline(_v:string){}} as unknown as CanvasRenderingContext2D;
 for(let i=0;i<600;i++)m.frame(ctx,1/30,false,{x:.5,y:.5,active:true});
 expect(calls.length).toBeGreaterThan(100);
 expect(Array.from(m.head).every(h=>h<=m.rows+3)).toBe(true);
});
import {LorenzCloud,ProtonModel,Starfield,ThreeBody,waveHeight} from './lib/buzhoushan-effects-science';

it('Lorenz orbits stay on the bounded attractor',()=>{
 const c=new LorenzCloud(500,seeded());
 for(let i=0;i<300;i++)c.step(.005);
 for(let i=0;i<c.n;i++){expect(Math.abs(c.x[i])).toBeLessThan(40);expect(c.z[i]).toBeGreaterThan(-5);expect(c.z[i]).toBeLessThan(70);}
});
it('wave height is finite, bounded and ripples around the pointer',()=>{
 let max=0;for(let i=0;i<500;i++){const v=waveHeight(i*.07-17,i*.13,i*.05);max=Math.max(max,Math.abs(v));expect(Number.isFinite(v)).toBe(true);}
 expect(max).toBeLessThan(1.2);
 expect(Math.abs(waveHeight(0,0,0,{x:0,z:0})-waveHeight(0,0,0))).toBeGreaterThan(.5);
});
it('stars always stay in front of the camera and respawn far away',()=>{
 const s=new Starfield(2000,40,seeded());
 for(let i=0;i<400;i++){s.step(.4);}
 for(let i=0;i<s.n;i++){expect(s.z[i]).toBeGreaterThan(0.1);expect(s.z[i]).toBeLessThanOrEqual(40);}
});
it('three-body figure-eight conserves energy over many steps',()=>{
 const b=new ThreeBody(seeded(),0.001);b.reseed(0);
 const e0=b.energy();for(let i=0;i<4000;i++)b.step(0.002);
 expect(Math.abs((b.energy()-e0)/e0)).toBeLessThan(5e-3);
 expect(b.extent()).toBeLessThan(3);
});
it('three-body perturbation stays finite and the centre of mass does not drift',()=>{
 const b=new ThreeBody(seeded());b.reseed(.06);
 const [x0,y0]=b.center();
 for(let i=0;i<20000;i++)b.step(.003);
 for(let i=0;i<3;i++)expect(Number.isFinite(b.x[i]+b.vy[i])).toBe(true);
 const [x1,y1]=b.center();expect(Math.hypot(x1-x0,y1-y0)).toBeLessThan(.5);
});
it('proton sea pairs spawn, age and annihilate within bounds',()=>{
 const p=new ProtonModel(100,seeded());
 for(let i=0;i<300;i++)p.update(1/60);
 expect(p.pairs.length).toBeGreaterThan(0);expect(p.pairs.length).toBeLessThanOrEqual(60);
 for(const q of p.pairs){expect(q.age).toBeLessThan(q.life);expect(Math.hypot(q.x,q.y,q.z)).toBeLessThanOrEqual(1.06);}
 const a=p.quark(0,1.2),b=p.quark(1,1.2),c=p.quark(2,1.2);
 for(const v of [a,b,c])expect(Math.hypot(...v)).toBeLessThan(1.5);
});
import {GlyphRipple,rippleBrightness,rippleHeight} from './lib/buzhoushan-effects-science';
it('a voice kick throws nearby particles outward and leaves distant ones alone',()=>{
 const f=new ParticleField(2,400,300,()=>.5);
 f.x.set([210,390]);f.y.set([150,290]);f.vx.fill(0);f.vy.fill(0);
 f.kick(200,150,.8,60);
 expect(f.vx[0]).toBeGreaterThan(0);expect(Math.abs(f.vy[0])).toBeLessThan(1e-3);
 expect(f.vx[1]).toBe(0);expect(f.vy[1]).toBe(0);
});
it('wave ripples are rings that expand and fade',()=>{
 const r=[{x:0,z:10,t0:0,amp:1}];
 const at=(d:number,t:number)=>rippleHeight(d,10,t,r);
 expect(at(4.5*1,1)).toBeGreaterThan(at(0,1));          // the crest is out at the ring radius
 expect(at(4.5*2,2)).toBeLessThan(at(4.5*1,1));          // and fades with age
 expect(at(3,4)).toBe(0);                                // expired
 expect(rippleHeight(0,0,0,[])).toBe(0);
});
it('glyph ripple brightness peaks on the expanding ring and is bounded',()=>{
 const age=.8,radius=(13+14*.7)*age;
 expect(rippleBrightness(radius,age,.7)).toBeGreaterThan(rippleBrightness(0,age,.7));
 expect(rippleBrightness(radius,age,.7)).toBeGreaterThan(rippleBrightness(radius+8,age,.7));
 expect(rippleBrightness(radius,3,.7)).toBe(0);
 for(const a of [0,.3,1,2])for(const d of [0,5,20,60])expect(rippleBrightness(d,a,1)).toBeLessThanOrEqual(1.3);
 const _t:GlyphRipple|undefined=undefined;void _t;
});
import {ShockRings} from './lib/buzhoushan-effects-science';
it('a three-body voice kick pushes the nearest sun away and the system stays finite',()=>{
 const b=new ThreeBody(seeded(),0.04);b.reseed(0);
 const i=b.nearest(b.x[1]+.05,b.y[1]);expect(i).toBe(1);
 const before=[b.vx[1],b.vy[1]],dx=b.x[1]-(b.x[1]+.05);
 b.kick(b.x[1]+.05,b.y[1],1);
 expect(Math.sign(b.vx[1]-before[0])).toBe(Math.sign(dx));
 expect(Math.hypot(b.vx[1]-before[0],b.vy[1]-before[1])).toBeCloseTo(.14,6);
 for(let n=0;n<6000;n++){if(n%400===0)b.kick(Math.sin(n)*2,Math.cos(n)*2,.8);b.step(.003);}
 for(let k=0;k<3;k++)expect(Number.isFinite(b.x[k]+b.y[k]+b.vx[k]+b.vy[k])).toBe(true);
});
it('shock rings push points outward from the click, then expire',()=>{
 const s=new ShockRings(1.1);s.add([{role:'mic',x:.5,y:.5,strength:1}],1000,600,0);
 let best=0;for(let t=0;t<1.1;t+=.05)for(let r=20;r<500;r+=10){const [dx,dy]=s.displacement(500+r,300,t,600);best=Math.max(best,dx);expect(Math.abs(dy)).toBeLessThan(1e-9);}
 expect(best).toBeGreaterThan(5);                              // points on the right are pushed right
 const [lx]=s.displacement(500-200,300,.5,600);expect(lx).toBeLessThanOrEqual(0); // and left points left
 s.prune(2);expect(s.rings.length).toBe(0);expect(s.displacement(700,300,2,600)).toEqual([0,0]);
});

it('a voice pulse makes the matrix columns around its pitch surge, tinted for the speaker, and revives idle columns',()=>{
 const m=new MatrixRain(16,seeded());m.resize(320,320);                       // 20 columns
 for(let c=0;c<m.cols;c++){m.head[c]=-50;m.speed[c]=8;}                       // every column is idle above the screen
 m.pulse(.5,.3,'mic');                                                          // a modest pulse: radius 7 columns
 const near=10,far=0;
 expect(m.boost[near]).toBeGreaterThan(.5);expect(m.tint[near]).toBe(1);
 expect(m.boost[far]).toBe(0);expect(m.tint[far]).toBe(0);
 expect(m.head[near]).toBeGreaterThanOrEqual(-2);expect(m.head[far]).toBe(-50);   // idle columns near the pulse restart at the top
 expect(m.speed[near]).toBeGreaterThanOrEqual(14);
 m.pulse(.5,.4,'ai');expect(m.tint[near]).toBe(2);                               // the latest speaker's colour wins
 const calls:string[]=[];
 const ctx={fillRect(){},fillText(){},set fillStyle(v:string){calls.push(v);},set font(_v:string){},set textBaseline(_v:string){}} as unknown as CanvasRenderingContext2D;
 const before=m.head[near];m.frame(ctx,.1,false);
 expect(m.head[near]-before).toBeGreaterThan(8*.1*2);                                // faster than the plain speed while pulsing
 for(let i=0;i<40;i++)m.frame(ctx,.1,false);
 expect(m.boost[near]).toBe(0);expect(m.tint[near]).toBe(0);                          // and it settles back
});
it('a voice burst fizzes up extra proton pairs but never beyond the cap',()=>{
 const p=new ProtonModel(50,seeded());
 const before=p.pairs.length;p.burst(1);
 expect(p.pairs.length-before).toBe(24);
 for(let i=0;i<20;i++)p.burst(1);
 expect(p.pairs.length).toBeLessThanOrEqual(90);
 for(const q of p.pairs){expect(Math.hypot(q.x,q.y,q.z)).toBeLessThanOrEqual(1.06);expect(q.life).toBeGreaterThan(0);}
 p.burst(.1);expect(p.pairs.length).toBeLessThanOrEqual(90);
});
