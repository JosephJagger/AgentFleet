import type {FleetSession, Machine} from './types';
export function hostSessionGroups(sessions:FleetSession[], machine?:Pick<Machine,'id'|'reachability'>) {
  const unique=[...new Map(sessions.filter(s=>s.machineId===machine?.id).map(s=>[s.id,s])).values()];
  const ordered=unique.sort((a,b)=>b.lastActivityAt.localeCompare(a.lastActivityAt)||a.id.localeCompare(b.id));
  const running=ordered.filter(s=>machine?.reachability==='live' && s.state.reachability==='live' && !s.state.unknownFreeze && (s.state.currentTurn==='in_progress'||Boolean(s.activeTurnId))).sort((a,b)=>a.id.localeCompare(b.id));
  const active=new Set(running.map(s=>s.id));
  const managed=ordered.filter(s=>!active.has(s.id)&&s.state.ownership==='agentfleet_owned'&&Boolean(s.nativeThreadId));
  return {running,managed};
}
export function preferredHostSession(groups:ReturnType<typeof hostSessionGroups>, remembered?:string) {
  if(groups.running.length===1)return groups.running[0].id;
  return (groups.running.length?groups.running:groups.managed).find(s=>s.id===remembered)?.id;
}
const key=(owner:string)=>`agentfleet.host-session:${owner}`;
export function rememberedHostSession(owner:string,host:string):string|undefined {
  try {const value=JSON.parse(sessionStorage.getItem(key(owner))||'{}')[host];return typeof value==='string'?value:undefined;}catch{return undefined;}
}
export function rememberHostSession(owner:string,host:string,session:string) {
  try {const previous=JSON.parse(sessionStorage.getItem(key(owner))||'{}');const entries=Object.entries(previous).filter(([id,value])=>id!==host&&typeof value==='string').slice(-199);sessionStorage.setItem(key(owner),JSON.stringify(Object.fromEntries([...entries,[host,session]])));}catch{/* Optional browser navigation memory. */}
}
