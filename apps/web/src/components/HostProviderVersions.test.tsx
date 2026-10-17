// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {HostProviderVersions} from './HostProviderVersions';
import {api} from '../lib/api';
import type {Machine,HostOperation} from '../lib/types';
vi.mock('../lib/api',()=>({api:{hostOperations:vi.fn(),providerRuntimeOperation:vi.fn(),readHostOperation:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const machine={name:'Test host',hostname:'test',os:'linux',arch:'x64',identity:'paired',capacity:'idle',credentialProtectionLevel:'software_protected',agentVersion:'test',projects:[],id:'test-host',reachability:'live',codexVersion:'0.162.1',compatibility:'compatible',codexProfile:{source:'managed'},agentRuntimes:{claude:{installed:true,version:'2.1.290'}},maintenanceCapabilities:['provider.runtime']} as Machine;
const report={createdAt:'2026-10-17T00:00:00Z',updatedAt:'2026-10-17T00:00:00Z',id:'checked',type:'provider.runtime',state:'succeeded',result:{checkedAt:'2026-10-17T00:00:00Z',providers:{claude:{version:'2.1.290',installed:true,mode:'host',revision:3,stableVersion:'2.1.292',sdkVersion:'0.3.285',compatibility:'protocol_checked'}}}} as HostOperation;
it('shows all providers, distinguishes handshake from full compatibility, never opts in on render',async()=>{
 vi.mocked(api.hostOperations).mockResolvedValue([report]);render(<HostProviderVersions machine={machine}/>);
 await screen.findByText('2.1.290');for(const name of ['Codex','Claude Code','Cursor','Qwen Code','Kimi Code','CodeBuddy Code','Grok Build'])expect(screen.getByText(name)).toBeTruthy();
 await screen.findByText('协议检查通过');expect(api.providerRuntimeOperation).not.toHaveBeenCalled();
});
it('explicit save carries host, policy and conflict revision; old hosts cannot mutate',async()=>{
 vi.mocked(api.hostOperations).mockResolvedValue([report]);vi.mocked(api.providerRuntimeOperation).mockResolvedValue({...report,id:'saved'});
 const r=render(<HostProviderVersions machine={machine}/>);await screen.findByText('协议检查通过');
 fireEvent.change(screen.getByLabelText('Claude Code 更新方式'),{target:{value:'auto'}});fireEvent.click(screen.getByText('应用更新方式'));
 await waitFor(()=>expect(api.providerRuntimeOperation).toHaveBeenCalledWith('test-host',{action:'configure',provider:'claude',mode:'auto',expectedRevision:3},expect.any(String)));
 r.unmount();render(<HostProviderVersions machine={{...machine,maintenanceCapabilities:[]}}/>);expect((screen.getByText('检查智能体版本').closest('button') as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByText('应用更新方式')).toBeNull();
});
it('unknown mutation result blocks resubmission and newer heartbeat policy wins over old report',async()=>{
 vi.mocked(api.hostOperations).mockResolvedValue([{...report,state:'unknown'}]);vi.mocked(api.readHostOperation).mockResolvedValue({...report,state:'unknown'});
 render(<HostProviderVersions machine={{...machine,discovery:{state:'ready',providerRuntimePolicy:{revision:4,mode:'pinned'}} as Machine['discovery']}}/>);
 await screen.findByText('操作结果待核验，请勿重复提交。');expect((screen.getByLabelText('Claude Code 更新方式') as HTMLSelectElement).value).toBe('pinned');expect((screen.getByText('应用更新方式') as HTMLButtonElement).disabled).toBe(true);
});
it('offers explicit confirmations and notices from discovery, and never acts on render',async()=>{
 vi.mocked(api.hostOperations).mockResolvedValue([]);vi.mocked(api.providerRuntimeOperation).mockResolvedValue({...report,id:'confirmed'});
 const m={...machine,agentRuntimes:{qwen:{installed:true,version:'0.24.0',state:'ready'}},codexProfile:{source:'managed',runtimeUpdateState:'awaiting_confirmation',runtimeUpdateTarget:'0.163.0'},
  discovery:{state:'ready',providerRuntimePolicy:{revision:2,mode:'pinned',current:{version:'2.1.292',sha256:'a'.repeat(64),size:1,platform:'linux-x64',checkedAt:'2026-10-17T00:00:00Z',sdkVersion:'0.3.285'},latest:{claude:{version:'2.1.300',checkedAt:'2026-10-17T00:00:00Z'},qwen:{version:'0.25.2',checkedAt:'2026-10-17T00:00:00Z'}}}}} as unknown as Machine;
 render(<HostProviderVersions machine={m} canConfirmCodex/>);
 await screen.findByText('确认更新到 0.163.0');await screen.findByText('更新到 2.1.300');await screen.findByText('有新版本 0.25.2，请用原安装方式更新');
 expect(api.providerRuntimeOperation).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText('确认更新到 0.163.0'));
 await waitFor(()=>expect(api.providerRuntimeOperation).toHaveBeenCalledWith('test-host',{action:'confirm',provider:'codex',version:'0.163.0'},expect.any(String)));
});
it('Claude update carries the policy revision and is disabled on hosts that cannot manage versions',async()=>{
 vi.mocked(api.hostOperations).mockResolvedValue([]);vi.mocked(api.providerRuntimeOperation).mockResolvedValue({...report,id:'updated'});
 const policy={revision:5,mode:'pinned',current:{version:'2.1.292',sha256:'a'.repeat(64),size:1,platform:'linux-x64',checkedAt:'2026-10-17T00:00:00Z',sdkVersion:'0.3.285'},latest:{claude:{version:'2.1.300',checkedAt:'2026-10-17T00:00:00Z'}}};
 const r=render(<HostProviderVersions machine={{...machine,discovery:{state:'ready',providerRuntimePolicy:policy}} as unknown as Machine}/>);
 fireEvent.click(await screen.findByText('更新到 2.1.300'));
 await waitFor(()=>expect(api.providerRuntimeOperation).toHaveBeenCalledWith('test-host',{action:'update',provider:'claude',expectedRevision:5},expect.any(String)));
 r.unmount();render(<HostProviderVersions machine={{...machine,maintenanceCapabilities:[],discovery:{state:'ready',providerRuntimePolicy:policy}} as unknown as Machine}/>);
 expect((await screen.findByText('更新到 2.1.300') as HTMLButtonElement).closest('button')!.disabled).toBe(true);
});

it('members who are not the platform administrator see Codex awaiting confirmation but cannot confirm it',async()=>{
 vi.mocked(api.hostOperations).mockResolvedValue([]);
 const m={...machine,codexProfile:{source:'managed',runtimeUpdateState:'awaiting_confirmation',runtimeUpdateTarget:'0.163.0'}} as unknown as Machine;
 render(<HostProviderVersions machine={m}/>);
 await screen.findByText('需平台管理员确认');expect(screen.queryByText('确认更新到 0.163.0')).toBeNull();expect(api.providerRuntimeOperation).not.toHaveBeenCalled();
});
