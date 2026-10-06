// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {HostVersionStorage} from './components/HostVersionStorage';
import {api} from './lib/api';
import type {Machine,HostOperation} from './lib/types';
vi.mock('./lib/api',()=>({api:{hostOperations:vi.fn(),hostOperation:vi.fn(),readHostOperation:vi.fn()}}));
const machine={id:'host',reachability:'live',maintenanceCapabilities:['versions.preview','versions.clean']} as Machine;
const report={checkedAt:new Date().toISOString(),totalBytes:1000,reclaimableBytes:500,deletedBytes:0,deletedCount:0,entryCount:0,entries:[]};
const preview={id:'preview',type:'versions.preview',state:'succeeded',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),result:report} as HostOperation;
beforeEach(()=>{vi.mocked(api.hostOperations).mockResolvedValue([preview]);});
afterEach(()=>{cleanup();vi.clearAllMocks();});
function open(m=machine){render(<HostVersionStorage machine={m}/>);fireEvent.click(screen.getByText('版本清理'));}
it('never enables cleanup for offline or unsupported hosts',async()=>{open({...machine,reachability:'unreachable'});await screen.findByText('主机离线，连接后可检查和清理。');expect(screen.getByRole('button',{name:'一键清理'}).hasAttribute('disabled')).toBe(true);cleanup();open({...machine,maintenanceCapabilities:[]});expect(screen.queryByRole('button',{name:'一键清理'})).toBeNull();});
it('one click submits one cleanup and shows confirmed results',async()=>{vi.mocked(api.hostOperation).mockResolvedValue({id:'clean',type:'versions.clean',state:'accepted'} as HostOperation);vi.mocked(api.readHostOperation).mockResolvedValue({id:'clean',type:'versions.clean',state:'succeeded',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),result:{...report,reclaimableBytes:0,deletedBytes:500,deletedCount:2}} as HostOperation);open();await waitFor(()=>expect(screen.getByRole('button',{name:'一键清理'}).hasAttribute('disabled')).toBe(false));fireEvent.click(screen.getByRole('button',{name:'一键清理'}));await screen.findByText(/删除 2 个旧版本目录/);expect(api.hostOperation).toHaveBeenCalledTimes(1);expect(api.hostOperation).toHaveBeenCalledWith('host','versions.clean',expect.any(String));});
it('unknown receipts disable retries and never claim success',async()=>{vi.mocked(api.hostOperations).mockResolvedValue([{...preview,state:'unknown',type:'versions.clean'}]);vi.mocked(api.readHostOperation).mockResolvedValue({...preview,state:'unknown',type:'versions.clean'});open();await screen.findByText('结果待核验，请勿重复清理');expect(screen.queryByText(/已清理 .*删除/)).toBeNull();expect(screen.getByRole('button',{name:'一键清理'}).hasAttribute('disabled')).toBe(true);});
