/** Short-lived, tab-local hints, never credentials, SDP, events or task payloads. */
const prefix='agentfleet.reload-connection.';
export function clearReloadConnection(kind:'voice'|'collector') {try{sessionStorage.removeItem(prefix+kind);}catch{/* Optional recovery hint. */}}
export function saveReloadConnection(kind:'voice'|'collector',target:string) {try{sessionStorage.setItem(prefix+kind,JSON.stringify({target,at:Date.now()}));}catch{/* Manual reconnect remains available. */}}
export function readReloadConnection(kind:'voice'|'collector'):string {
 try {
  if((performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming|undefined)?.type!=='reload')return '';
  const saved=JSON.parse(sessionStorage.getItem(prefix+kind)||'null');
  const age=Date.now()-saved?.at;
  return typeof saved?.target==='string'&&saved.target.length<=200&&age>=0&&age<300000?saved.target:'';
 }catch{return '';}
}
