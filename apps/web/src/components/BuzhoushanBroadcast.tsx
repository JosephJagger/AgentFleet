import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Download,MonitorUp,Ratio,X} from 'lucide-react';
import {t} from '../i18n';
import {downloadBroadcastLauncher} from '../lib/broadcast-launcher';

export function BuzhoushanBroadcastControl({enabled,onChange}:{enabled:boolean;onChange:(enabled:boolean)=>void}) {
  const [open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(!open)return;const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[open]);
  return <div ref={root} className="buzhou-broadcast-controls" onKeyDown={event=>{if(event.key==='Escape'&&open){event.stopPropagation();setOpen(false);trigger.current?.focus();}}}>
    <button type="button" className="buzhou-focus-toggle buzhou-broadcast-toggle" aria-pressed={enabled} title={t('固定 16:9 内容区域，宽屏留边；采集时裁剪到画布边界并保持比例')} onClick={()=>onChange(!enabled)}><Ratio size={14}/>{t(enabled?'退出 16:9':'16:9 画布')}</button>
    <button ref={trigger} type="button" className="buzhou-focus-toggle buzhou-broadcast-toggle" aria-label={t('直播采集设置')} aria-expanded={open} onClick={()=>setOpen(v=>!v)}><MonitorUp size={14}/></button>
    {open&&<section className="buzhou-broadcast-help" aria-label={t('直播采集设置')}>
      <header><strong>{t('直播采集设置')}</strong><button type="button" className="icon-button" aria-label={t('关闭')} onClick={()=>{setOpen(false);trigger.current?.focus();}}><X size={15}/></button></header>
      <p>{t('开启 16:9 画布后，裁剪素材到画布边界，再按比例适配 1920 × 1080。宽屏两侧留边属于画布之外。')}</p>
      <p>{t('遮挡后动画停住？下载 Windows 直播启动器，双击打开独立的 Edge / Chrome 窗口，再让直播伴侣采集这个窗口。')}</p>
      <button type="button" className="button button--primary" onClick={downloadBroadcastLauncher}><Download size={14}/>{t('下载 Windows 直播启动器')}</button>
      <small>{t('首次需要重新登录。直播窗口使用独立配置，关闭后台节流；采集时保持窗口未最小化。浏览器版本和采集方式仍可能影响效果。')}</small>
    </section>}
  </div>;
}

export function BuzhoushanBroadcastStatus() {
  const ref=useRef<HTMLOutputElement>(null);
  const [size,setSize]=useState({width:0,height:0,x:0,y:0});
  useLayoutEffect(()=>{
    const stage=ref.current?.closest('.app-shell');if(!stage)return;
    const measure=()=>{const r=stage.getBoundingClientRect();setSize({width:Math.round(r.width),height:Math.round(r.height),x:Math.round(r.left),y:Math.round(r.top)});};
    measure();const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(measure);observer?.observe(stage);
    window.addEventListener('resize',measure);return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
  },[]);
  return <output ref={ref} className="buzhou-broadcast-size" aria-label={t('直播画布尺寸')} title={t('画布 {0} × {1}；网页左右留边各 {2}px，上下留边各 {3}px。窗口采集请裁掉留边，按比例适配 1920 × 1080，勿拉伸铺满。',size.width,size.height,size.x,size.y)}>16:9 · {size.width} × {size.height}</output>;
}
