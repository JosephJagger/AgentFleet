import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Download,MonitorUp,Ratio,Sparkles,X} from 'lucide-react';
import {createPortal} from 'react-dom';
import {t} from '../i18n';
import {SCREENSAVER_MODES,setScreensaverPreview,useScreensaverPrefs,type ScreensaverMode,saveScreensaverPrefs,SCREENSAVER_MIN_SECONDS,SCREENSAVER_MAX_SECONDS} from '../lib/buzhoushan-idle';
import {downloadBroadcastLauncher,openBroadcastWindow,fitBroadcastWindow} from '../lib/broadcast-launcher';

type BroadcastIntro = {leftTitle:string;leftSubtitle:string;rightTitle:string;rightSubtitle:string};
const introKey='agentfleet:buzhoushan-broadcast-intro';
const defaultIntro:BroadcastIntro={leftTitle:'AI 编程实战',leftSubtitle:'Codex · Claude Code',rightTitle:'多电脑 AI 协作直播中',rightSubtitle:'现场开发｜调试｜交流答疑'};
function readIntro():BroadcastIntro {
  try {const saved=JSON.parse(localStorage.getItem(introKey)||'{}');return Object.fromEntries(Object.entries(defaultIntro).map(([key,value])=>[key,typeof saved?.[key]==='string'?saved[key].slice(0,40):value])) as BroadcastIntro;}catch{return {...defaultIntro};}
}

function IntroWords({text}:{text:string}) {
  return <>{text.split(/(\s+|｜)/u).filter(Boolean).map((part,index)=>/^(\s+|｜)$/u.test(part)?<span key={index} className="buzhou-broadcast-rail__separator">{part}</span>:<span key={index} className="buzhou-broadcast-rail__word">{part}</span>)}</>;
}

/** Introductions are part of the same 16:9 composition as the reflowing workspace. */
export function BuzhoushanBroadcastIntro({intro=defaultIntro}:{intro?:BroadcastIntro}) {
  return <div className="buzhou-broadcast-intro" aria-label={t('直播间介绍')}>
    <aside className="buzhou-broadcast-rail buzhou-broadcast-rail--left"><div className="buzhou-broadcast-rail__content">
      <span className="buzhou-broadcast-rail__eyebrow">AGENTFLEETS</span>
      <svg className="buzhou-broadcast-rail__art" viewBox="0 0 180 130" fill="none" aria-hidden="true"><path d="M10 112 64 28l26 44 25-58 55 98Z" stroke="currentColor" strokeWidth="2"/><path d="m36 112 35-55 19 32 25-50 33 73M10 120h160" stroke="currentColor" opacity=".3"/><circle cx="115" cy="14" r="4" fill="currentColor"/></svg>
      <h2><IntroWords text={intro.leftTitle}/></h2><p><IntroWords text={intro.leftSubtitle}/></p><span className="buzhou-broadcast-rail__rule"/>
    </div></aside>
    <aside className="buzhou-broadcast-rail buzhou-broadcast-rail--right"><div className="buzhou-broadcast-rail__content">
      <span className="buzhou-broadcast-rail__eyebrow">BUILD TOGETHER</span>
      <svg className="buzhou-broadcast-rail__art" viewBox="0 0 180 130" fill="none" aria-hidden="true"><path d="M90 40v37M43 77h94M43 77v13m94-13v13" stroke="currentColor" opacity=".5" strokeWidth="2"/><rect x="66" y="12" width="48" height="30" rx="4" stroke="currentColor" strokeWidth="2"/><rect x="18" y="90" width="50" height="30" rx="4" stroke="currentColor" strokeWidth="2"/><rect x="112" y="90" width="50" height="30" rx="4" stroke="currentColor" strokeWidth="2"/><path d="m82 21-6 6 6 6m16-12 6 6-6 6" stroke="currentColor"/><circle cx="90" cy="77" r="4" fill="currentColor"/></svg>
      <h2><IntroWords text={intro.rightTitle}/></h2><p><IntroWords text={intro.rightSubtitle}/></p><span className="buzhou-broadcast-rail__rule"/>
    </div></aside>
  </div>;
}

export function BuzhoushanBroadcastControl({enabled,onChange}:{enabled:boolean;onChange:(enabled:boolean)=>void}) {
  const [intro,setIntro]=useState(readIntro);
  const [windowBlocked,setWindowBlocked]=useState(false);
  const saver=useScreensaverPrefs();
  useEffect(()=>{fitBroadcastWindow();},[]);
  const [open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(!open)return;const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[open]);
  return <div ref={root} className="buzhou-broadcast-controls" onKeyDown={event=>{if(event.key==='Escape'&&open){event.stopPropagation();setOpen(false);trigger.current?.focus();}}}>
    <button type="button" className="buzhou-focus-toggle buzhou-broadcast-toggle" aria-pressed={enabled} title={t('工作区与两侧介绍共同组成 16:9 画布')} onClick={()=>onChange(!enabled)}><Ratio size={14}/>{t(enabled?'退出 16:9':'16:9 画布')}</button>
    <button type="button" className="buzhou-focus-toggle buzhou-broadcast-toggle" title={t('立即预览直播屏保，点击任意处退出')} onClick={()=>setScreensaverPreview(true)}><Sparkles size={14}/>{t('屏保测试')}</button>
    <button ref={trigger} type="button" className="buzhou-focus-toggle buzhou-broadcast-toggle" aria-label={t('直播采集设置')} aria-expanded={open} onClick={()=>setOpen(v=>!v)}><MonitorUp size={14}/></button>
    {open&&<section className="buzhou-broadcast-help" aria-label={t('直播采集设置')}>
      <header><strong>{t('直播采集设置')}</strong><button type="button" className="icon-button" aria-label={t('关闭')} onClick={()=>{setOpen(false);trigger.current?.focus();}}><X size={15}/></button></header>
      <p>{t('工作区与介绍都在 16:9 画布内。建议打开独立直播窗口，采集时裁掉标题栏和画布外黑边，再等比适配；不要拉伸铺满。')}</p>
      <button type="button" className="button" onClick={()=>setWindowBlocked(!openBroadcastWindow())}><MonitorUp size={14}/>{t('打开 16:9 直播窗口')}</button>
      {windowBlocked&&<p role="status">{t('窗口未打开，请允许本站弹出窗口后重试。')}</p>}
      <small>{t('新窗口不会转移当前通话；请勿关闭正在通话的原窗口。窗口尺寸可能受系统限制，以底部画布尺寸为准。')}</small>
      <details className="buzhou-broadcast-editor"><summary>{t('空闲屏保特效')}</summary>
        <label><input type="checkbox" checked={saver.enabled} onChange={event=>saveScreensaverPrefs({...saver,enabled:event.target.checked})}/> {t('长时间无鼠标键盘操作时显示直播屏保')}</label>
        <label>{t('屏保效果')}<select value={saver.mode} onChange={event=>saveScreensaverPrefs({...saver,mode:event.target.value as ScreensaverMode})}>{SCREENSAVER_MODES.map(mode=><option key={mode} value={mode}>{t(({auto:'自动轮换',particles:'粒子引力场',smoke:'流体烟雾',matrix:'数字雨',attractor:'吸引子轨迹',wavegrid:'波浪网格',starfield:'星空',threebody:'三体太阳轨迹',proton:'质子'} as Record<ScreensaverMode,string>)[mode])}</option>)}</select></label>
        <label>{t('空闲秒数')}<input type="number" min={SCREENSAVER_MIN_SECONDS} max={SCREENSAVER_MAX_SECONDS} value={saver.seconds} onChange={event=>saveScreensaverPrefs({...saver,seconds:Number(event.target.value)})}/></label>
        <small>{t('仅为视觉特效：不拦截点击，不影响通话、互动消息和任务；任意操作立即退出。')}</small>
      </details>
      <details className="buzhou-broadcast-editor"><summary>{t('编辑直播介绍')}</summary>
        {(Object.keys(defaultIntro) as (keyof BroadcastIntro)[]).map((key,index)=><label key={key}>{t(['左侧标题','左侧副标题','右侧标题','右侧副标题'][index])}<input maxLength={40} value={intro[key]} onChange={event=>{const next={...intro,[key]:event.target.value};setIntro(next);try{localStorage.setItem(introKey,JSON.stringify(next));}catch{/* The current page still updates when storage is unavailable. */}}}/></label>)}
        <small>{t('仅保存在本浏览器；画布较小时自动隐藏介绍，优先保证工作区。')}</small>
      </details>
      <p>{t('遮挡后动画停住？下载 Windows 直播启动器，双击打开独立的 Edge / Chrome 窗口，再让直播伴侣采集这个窗口。')}</p>
      <button type="button" className="button button--primary" onClick={downloadBroadcastLauncher}><Download size={14}/>{t('下载 Windows 直播启动器')}</button>
      <small>{t('首次需要重新登录。直播窗口使用独立配置，关闭后台节流；采集时保持窗口未最小化。浏览器版本和采集方式仍可能影响效果。')}</small>
    </section>}
    {enabled&&createPortal(<BuzhoushanBroadcastIntro intro={intro}/>,document.body)}
  </div>;
}

export function BuzhoushanBroadcastStatus() {
  const ref=useRef<HTMLOutputElement>(null);
  const [size,setSize]=useState({width:0,height:0,x:0,y:0});
  useLayoutEffect(()=>{
    const stage=ref.current?.closest('.app-shell');if(!stage)return;
    const measure=()=>{const r=stage.getBoundingClientRect();const left=document.querySelector('.buzhou-broadcast-rail--left')?.getBoundingClientRect();const right=document.querySelector('.buzhou-broadcast-rail--right')?.getBoundingClientRect();const hasCanvas=left&&right&&left.height>0;const x=hasCanvas?left.left:r.left;const width=hasCanvas?right.right-x:r.width;setSize({width:Math.round(width),height:Math.round(r.height),x:Math.round(x),y:Math.round(r.top)});};
    measure();const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(measure);observer?.observe(stage);
    window.addEventListener('resize',measure);return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
  },[]);
  return <output ref={ref} className="buzhou-broadcast-size" aria-label={t('直播画布尺寸')} title={t('完整画布 {0} × {1}（含介绍）；网页左右裁去各 {2}px，上下裁去各 {3}px，再等比适配。标题栏需另外裁掉。',size.width,size.height,size.x,size.y)}>16:9 · {size.width} × {size.height}</output>;
}
