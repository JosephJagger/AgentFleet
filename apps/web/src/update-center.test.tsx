// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateCenter } from './components/UpdateCenter';
import { HostUpdateStatus } from './components/HostUpdateStatus';
import { api } from './lib/api';
import type { Dashboard, HostOperation } from './lib/types';
vi.mock('./lib/api',()=>({api:{agentReleaseStatus:vi.fn(),hostOperations:vi.fn(),hostOperation:vi.fn(),release:vi.fn()}}));
vi.mock('./components/RuntimeReleasePanel',()=>({RuntimeReleasePanel:()=>null}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.resetAllMocks();});
it('does not certify a running version without its health receipt',()=>{
  render(<HostUpdateStatus compact machine={{agentVersion:'1.2.3',reachability:'live',codexProfile:{agentUpdateState:'restarting',agentUpdateTarget:'1.2.3'}}}/>);
  expect(screen.getByText('已运行目标版本，升级健康回执待核验')).toBeTruthy();
});
it('does not confuse last reported offline status with current progress',()=>{
  render(<HostUpdateStatus compact machine={{agentVersion:'1.2.3',reachability:'unreachable',codexProfile:{agentUpdateState:'succeeded'}}}/>);
  expect(screen.getByText('离线，显示最后上报状态')).toBeTruthy();
});
it('deduplicates manual update requests and stops polling when closed',async()=>{
  vi.useFakeTimers();
  vi.mocked(api.agentReleaseStatus).mockResolvedValue({status:'ready',expectedVersion:'1.0.1',publicVersion:'1.0.1',checkedAt:''});
  vi.mocked(api.release).mockResolvedValue({build:'test'} as never);
  vi.mocked(api.hostOperations).mockResolvedValue([]);
  let finish!:(operation:HostOperation)=>void;
  vi.mocked(api.hostOperation).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const dashboard={user:{platformAdmin:true},compatibilityProfile:{managedCodexVersion:'0.162.1',schemaHash:'',validationStatus:'verified'},machines:[{id:'test-host',name:'Synthetic host',identity:'paired',os:'linux',reachability:'live',agentVersion:'1.0.0',codexVersion:'0.162.1',maintenanceCapabilities:['agent.update'],codexProfile:{}}]} as unknown as Dashboard;
  const view=render(<UpdateCenter dashboard={dashboard}/>);
  await act(async()=>{});
  expect(view.container.querySelector('.update-center__components > div > small')).not.toBeNull();
  const button=screen.getByText('检查并更新');
  fireEvent.click(button);fireEvent.click(button);
  expect(api.hostOperation).toHaveBeenCalledTimes(1);
  await act(async()=>finish({id:'op-test',type:'agent.update',state:'accepted',updatedAt:'2026-01-01T00:00:00Z'} as HostOperation));
  expect(screen.getByRole('button',{name:'等待主机核验'}).hasAttribute('disabled')).toBe(true);
  view.unmount();
  await act(async()=>vi.advanceTimersByTimeAsync(30000));
  expect(api.agentReleaseStatus).toHaveBeenCalledTimes(1);
});

it('disables connection-service updates for users who are not the platform administrator',async()=>{
  vi.mocked(api.agentReleaseStatus).mockResolvedValue({status:'ready',expectedVersion:'1.0.1',publicVersion:'1.0.1',checkedAt:''});
  vi.mocked(api.hostOperations).mockResolvedValue([]);
  const dashboard={user:{platformAdmin:false},compatibilityProfile:{managedCodexVersion:'0.162.1',schemaHash:'',validationStatus:'verified'},machines:[{id:'test-host',name:'Synthetic host',identity:'paired',os:'linux',reachability:'live',agentVersion:'1.0.0',codexVersion:'0.162.1',maintenanceCapabilities:['agent.update'],codexProfile:{}}]} as unknown as Dashboard;
  const view=render(<UpdateCenter dashboard={dashboard}/>);
  await act(async()=>{});
  expect(view.container.textContent).toMatch(/Codex\s*\S+/);
  expect(view.container.querySelector('.update-center__components > div > small')).toBeNull();
  const button=screen.getByText('检查并更新').closest('button') as HTMLButtonElement;
  expect(button.disabled).toBe(true);fireEvent.click(button);
  expect(api.hostOperation).not.toHaveBeenCalled();
});
