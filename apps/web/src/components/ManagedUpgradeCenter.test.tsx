// @vitest-environment jsdom
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {ManagedUpgradeCenter} from './ManagedUpgradeCenter';
import {ManagedHostAction} from './ManagedHostAction';
import {api} from '../lib/api';
import type {Machine} from '../lib/types';
import type {ManagedRelease} from '../lib/managed-provider';
vi.mock('../lib/api',()=>({api:{managedHosts:vi.fn(),managedReleases:vi.fn(),runtimeRelease:vi.fn(),agentReleaseStatus:vi.fn(),managedReleaseControl:vi.fn(),providerRuntimeOperation:vi.fn(),readHostOperation:vi.fn()}}));
const target:ManagedRelease={id:'a'.repeat(64),provider:'grok',version:'1.0.70',checkedAt:'2026-10-26T00:00:00Z',artifacts:{'linux-x64':{integrity:'x',size:1}}};
const machine={id:'home',name:'Home',identity:'paired',os:'linux',arch:'x64',reachability:'live',agentVersion:'0.30.152',codexVersion:'0.164.0',codexProfile:{source:'managed'},discovery:{state:'ready',managedProviderSupport:true,managedGrokVersion:'1.0.62'},agentRuntimes:{grok:{version:'1.0.62',installed:true}}} as unknown as Machine;
beforeEach(()=>{
 vi.mocked(api.managedHosts).mockResolvedValue([machine]);vi.mocked(api.managedReleases).mockResolvedValue({configured:true,channels:[{provider:'grok',revision:1,phase:'ready',candidate:target,history:[]}]});
 vi.mocked(api.runtimeRelease).mockResolvedValue({configured:true,canControl:true,paused:false,workerOnline:true,phase:'idle',target:{version:'0.164.0'},checks:[],history:[],message:''});
 vi.mocked(api.agentReleaseStatus).mockResolvedValue({status:'ready',publicVersion:'0.30.152',expectedVersion:'0.30.152',checkedAt:target.checkedAt});
 vi.mocked(api.providerRuntimeOperation).mockResolvedValue({id:'accepted',type:'provider.runtime',state:'succeeded',createdAt:target.checkedAt,updatedAt:target.checkedAt,result:{accepted:true}});
});
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('selects agents without mutating, and publishes only after confirming the exact candidate',async()=>{
 render(<ManagedUpgradeCenter/>);await screen.findByText('Home');
 fireEvent.click(screen.getByRole('button',{name:/Grok Build/}));
 expect(screen.getByText('尚未发布托管版本')).toBeTruthy();expect(api.managedReleaseControl).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText('设为托管目标'));expect(api.managedReleaseControl).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'确认'}));
 await waitFor(()=>expect(api.managedReleaseControl).toHaveBeenCalledWith('grok',{action:'publish',revision:1,releaseId:target.id}));
});
it('submission acknowledgement is not completion, and live progress replaces the action',async()=>{
 const r=render(<ManagedHostAction machine={machine} provider="grok" target={target}/>);
 fireEvent.click(screen.getByRole('button',{name:'更新到 1.0.70'}));await screen.findByText('请求已提交，等待主机上报进度');
 expect(screen.queryByText('更新完成')).toBeNull();expect((screen.getByRole('button',{name:'更新到 1.0.70'}) as HTMLButtonElement).disabled).toBe(true);
 const job={provider:'grok' as const,revision:1,operationId:'op',phase:'waiting_idle' as const,targetVersion:target.version,releaseId:target.id,updatedAt:target.checkedAt};
 r.rerender(<ManagedHostAction machine={{...machine,discovery:{...machine.discovery!,managedUpdates:{grok:job}}}} provider="grok" target={target}/>);
 expect(screen.getByText('等待任务和通话结束')).toBeTruthy();expect(screen.getByRole('button',{name:'取消更新'})).toBeTruthy();
 r.rerender(<ManagedHostAction machine={{...machine,discovery:{...machine.discovery!,managedGrokVersion:'1.0.70',managedUpdates:{grok:{...job,phase:'succeeded'}}}}} provider="grok" target={target}/>);
 expect(screen.getByText('等待实际版本上报')).toBeTruthy();
 r.rerender(<ManagedHostAction machine={{...machine,agentRuntimes:{grok:{...machine.agentRuntimes!.grok!,version:'1.0.70'}},discovery:{...machine.discovery!,managedGrokVersion:'1.0.70',managedUpdates:{grok:{...job,phase:'succeeded'}}}}} provider="grok" target={target}/>);
 expect(screen.getByText('已是托管目标')).toBeTruthy();
});
it('old connection services and offline hosts cannot submit new managed installation requests',()=>{
 const r=render(<ManagedHostAction machine={{...machine,discovery:{...machine.discovery!,managedProviderSupport:false}}} provider="grok" target={target}/>);
 expect(screen.getByText('请先更新连接服务')).toBeTruthy();expect(screen.queryByRole('button')).toBeNull();
 r.rerender(<ManagedHostAction machine={{...machine,reachability:'unreachable'}} provider="grok" target={target}/>);
 expect(screen.getByText('离线 · 等待连接')).toBeTruthy();expect(screen.queryByRole('button')).toBeNull();
});

it('a host rejecting an accepted command releases the button and displays the actual failure',async()=>{
 vi.mocked(api.providerRuntimeOperation).mockResolvedValue({id:'pending',type:'provider.runtime',state:'accepted',createdAt:target.checkedAt,updatedAt:target.checkedAt});
 vi.mocked(api.readHostOperation).mockResolvedValue({id:'pending',type:'provider.runtime',state:'failed',createdAt:target.checkedAt,updatedAt:target.checkedAt,error:{code:'PROVIDER_TARGET_CHANGED',message:'托管目标已变化，请重新确认'}});
 render(<ManagedHostAction machine={machine} provider="grok" target={target}/>);
 fireEvent.click(screen.getByRole('button',{name:'更新到 1.0.70'}));
 await screen.findByText('托管目标已变化，请重新确认');
 await waitFor(()=>expect((screen.getByRole('button',{name:'更新到 1.0.70'}) as HTMLButtonElement).disabled).toBe(false));
 expect(screen.queryByText('更新完成')).toBeNull();
});
