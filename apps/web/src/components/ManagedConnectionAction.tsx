import {useEffect,useRef,useState} from 'react';
import {api} from '../lib/api';
import type {HostOperation,Machine} from '../lib/types';
import {HostUpdateStatus,type AgentReleaseStatus} from './HostUpdateStatus';
import {t,systemText} from '../i18n';

/** Command acknowledgements and the subsequent health receipt are displayed separately. */
export function ManagedConnectionAction({machine,release}:{machine:Machine;release?:AgentReleaseStatus}) {
  const [operations,setOperations]=useState<HostOperation[]>([]),[sending,setSending]=useState(false),[error,setError]=useState('');
  const lock=useRef(false);
  useEffect(()=>{const controller=new AbortController();let reading=false;
    const refresh=async()=>{if(reading)return;reading=true;try{const next=await api.hostOperations(machine.id,controller.signal);if(!controller.signal.aborted)setOperations(next);}catch{if(!controller.signal.aborted)setError(t('操作记录暂时无法读取'));}finally{reading=false;}};
    void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>{controller.abort();clearInterval(timer);};
  },[machine.id]);
  const pending=operations.some(o=>o.type==='agent.update'&&['accepted','running','unknown'].includes(o.state));
  async function update(){if(lock.current)return;lock.current=true;setSending(true);setError('');try{const operation=await api.hostOperation(machine.id,'agent.update',crypto.randomUUID());setOperations(rows=>[operation,...rows.filter(o=>o.id!==operation.id)]);}catch(e){setError((e as Error).message);}finally{lock.current=false;setSending(false);}}
  return <div className="managed-host-action"><HostUpdateStatus machine={machine} operations={operations} release={release} compact/>
    <button className="managed-text-button" disabled={sending||pending||machine.reachability!=='live'||!machine.maintenanceCapabilities?.includes('agent.update')} onClick={()=>void update()}>{pending?t('等待主机核验'):sending?t('正在提交…'):t('检查并更新')}</button>
    {error&&<small role="alert" className="managed-error">{systemText(error)}</small>}
  </div>;
}
