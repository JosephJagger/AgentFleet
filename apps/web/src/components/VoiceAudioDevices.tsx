import {useEffect,useRef,useState} from 'react';
import {t} from '../i18n';

export function voiceMicrophoneConstraints(deviceId:string):MediaStreamConstraints {
 return {audio:{echoCancellation:true,noiseSuppression:true,...(deviceId?{deviceId:{exact:deviceId}}:{})},video:false};
}
function saved(key:string){try{return localStorage.getItem(key)??'';}catch{return '';}}
export function useVoiceDevicePreferences(){
 const [microphone,setMicrophone]=useState(()=>saved('voice.microphone'));
 const [speaker,setSpeaker]=useState(()=>saved('voice.speaker'));
 return {microphone,speaker,setMicrophone:(id:string)=>{setMicrophone(id);try{localStorage.setItem('voice.microphone',id);}catch{/* local storage optional */}},setSpeaker:(id:string)=>{setSpeaker(id);try{localStorage.setItem('voice.speaker',id);}catch{/* local storage optional */}}};
}

/** Measures only local samples, never records/uploads audio or starts a voice call. */
export function VoiceAudioDevices({active,stream,microphone,speaker,onMicrophone,onSpeaker,outputSupported}:{active:boolean;stream:MediaStream|null;microphone:string;speaker:string;onMicrophone:(id:string)=>void;onSpeaker:(id:string)=>void;outputSupported:boolean}){
 const [devices,setDevices]=useState<MediaDeviceInfo[]>([]),[error,setError]=useState(''),[level,setLevel]=useState<number|null>(null),[testing,setTesting]=useState(false);
 const testStream=useRef<MediaStream|null>(null),attempt=useRef(0);
 const [sample,setSample]=useState<MediaStream|null>(null);
 const stop=()=>{attempt.current++;testStream.current?.getTracks().forEach(track=>track.stop());testStream.current=null;setSample(null);setTesting(false);};
 useEffect(()=>{let alive=true;const refresh=()=>{void navigator.mediaDevices?.enumerateDevices?.().then(value=>{if(alive)setDevices(value);}).catch(()=>{if(alive)setError(t('无法读取音频设备，请检查浏览器权限'));});};refresh();navigator.mediaDevices?.addEventListener?.('devicechange',refresh);return()=>{alive=false;navigator.mediaDevices?.removeEventListener?.('devicechange',refresh);};},[stream,sample]);
 useEffect(()=>()=>{attempt.current++;testStream.current?.getTracks().forEach(track=>track.stop());},[]);
 useEffect(()=>{if(active){attempt.current++;testStream.current?.getTracks().forEach(track=>track.stop());testStream.current=null;setSample(null);setTesting(false);}},[active]);
 useEffect(()=>{
  const sourceStream=active?stream:sample;if(!sourceStream){setLevel(null);return;}
  if(typeof AudioContext==='undefined'){setError(t('此浏览器不支持音量检测'));return;}
  let context:AudioContext|undefined,source:MediaStreamAudioSourceNode|undefined,timer:ReturnType<typeof setInterval>|undefined;
  try{context=new AudioContext();source=context.createMediaStreamSource(sourceStream);const analyser=context.createAnalyser();analyser.fftSize=256;source.connect(analyser);const data=new Uint8Array(analyser.fftSize);
   void context.resume().catch(()=>setError(t('请重新点击检测以允许音频分析')));
   timer=setInterval(()=>{analyser.getByteTimeDomainData(data);const rms=Math.sqrt(data.reduce((sum,v)=>sum+((v-128)/128)**2,0)/data.length);setLevel(Math.min(100,Math.round(rms*400)));},100);
  }catch{setError(t('音量检测不可用，通话仍可继续'));}
  return()=>{clearInterval(timer);source?.disconnect();if(context)void context.close().catch(()=>undefined);};
 },[active,stream,sample]);
 async function test(){const id=++attempt.current;setTesting(true);setError('');try{const opened=await navigator.mediaDevices.getUserMedia(voiceMicrophoneConstraints(microphone));if(id!==attempt.current){opened.getTracks().forEach(track=>track.stop());return;}testStream.current=opened;setSample(opened);}catch{if(id===attempt.current){setTesting(false);setError(t('无法打开所选麦克风，请检查设备和权限'));}}}
 return <fieldset className="voice-audio-devices"><legend>{t('本机音频设备')}</legend>
  <label>{t('麦克风')}<select aria-label={t('麦克风')} disabled={active||testing} value={microphone} onChange={event=>onMicrophone(event.target.value)}><option value="">{t('系统默认')}</option>{microphone&&!devices.some(d=>d.deviceId===microphone)&&<option value={microphone}>{t('已选设备暂不可用')}</option>}{devices.filter(d=>d.kind==='audioinput'&&d.deviceId!=='default').map((d,i)=><option key={d.deviceId||i} value={d.deviceId}>{d.label||`${t('麦克风')} ${i+1}`}</option>)}</select></label>
  <label>{t('扬声器')}<select aria-label={t('扬声器')} disabled={!outputSupported} value={speaker} onChange={event=>onSpeaker(event.target.value)}><option value="">{t('系统默认')}</option>{speaker&&!devices.some(d=>d.deviceId===speaker)&&<option value={speaker}>{t('已选设备暂不可用')}</option>}{devices.filter(d=>d.kind==='audiooutput'&&d.deviceId!=='default').map((d,i)=><option key={d.deviceId||i} value={d.deviceId}>{d.label||`${t('扬声器')} ${i+1}`}</option>)}</select></label>
  {!outputSupported&&<small>{t('此浏览器不支持网页切换扬声器，请使用系统声音设置')}</small>}
  <small>{t('设备属于打开网页的电脑。麦克风切换在下次通话生效；允许权限后可显示设备名称。')}</small>
  {!active&&<button type="button" className="button button--secondary" onClick={()=>testing?stop():void test()}>{t(testing?'停止检测':'检测麦克风')}</button>}
  {level!==null&&<label>{t('输入音量')}<meter min={0} max={100} value={level} aria-label={t('输入音量')}/><small>{level===0?t('未检测到输入，请讲话或检查静音'): `${level}/100`}</small></label>}
  {error&&<p role="status">{error}</p>}
 </fieldset>;
}
