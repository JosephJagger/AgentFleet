import {useEffect,useRef,useState} from 'react';
import {t} from '../i18n';
/** User-initiated, authenticated read. Never embed model-supplied remote URLs directly. */
export function InlineMedia({url,label}:{url:string;label:string}){
 const [media,setMedia]=useState<{url:string;mime:string}>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const controller=useRef<AbortController | undefined>(undefined);const object=useRef<string | undefined>(undefined);
 useEffect(()=>{setMedia(undefined);setBusy(false);setError('');return()=>{controller.current?.abort();if(object.current)URL.revokeObjectURL(object.current);object.current=undefined;};},[url]);
 async function load(){
  if(busy||media)return;setBusy(true);setError('');const c=new AbortController();controller.current=c;
  try{
   const response=await fetch(url,{credentials:'same-origin',signal:c.signal});
   if(!response.ok){const data=await response.json().catch(()=>({}));throw Error(data.error?.message??t('预览失败，请下载查看'));}
   const mime=response.headers.get('content-type')?.split(';')[0]??'';
   if(!/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime))$/.test(mime))throw Error(t('此格式不支持内联预览'));
   const blob=await response.blob();if(c.signal.aborted)return;
   object.current=URL.createObjectURL(new Blob([blob],{type:mime}));setMedia({url:object.current,mime});
  }catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:t('预览失败，请下载查看'));}finally{if(!c.signal.aborted)setBusy(false);}
 }
 return <span className="inline-media">{media?media.mime.startsWith('video/')?<video controls preload="metadata" src={media.url} aria-label={label}/>:<img src={media.url} alt={label}/>:<button type="button" className="button button--secondary" disabled={busy} onClick={()=>void load()}>{busy?t('正在读取…'):t('展开图片或视频')} · {label}</button>}{error&&<span role="alert">{error}</span>}</span>;
}
