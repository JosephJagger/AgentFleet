// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TakeoverPolicyCard } from './components/TakeoverPolicyCard';
import { api } from './lib/api';
vi.mock('./lib/api',()=>({api:{takeoverPolicy:vi.fn(),saveTakeoverPolicy:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('loads persisted defaults, offers custom integer days, and saves only the independent policy',async()=>{
 vi.mocked(api.takeoverPolicy).mockResolvedValue({idleDays:14,revision:0});
 vi.mocked(api.saveTakeoverPolicy).mockResolvedValue({idleDays:9,revision:1});
 render(<TakeoverPolicyCard/>);
 expect((await screen.findByRole('button',{name:'14 天'})).getAttribute('aria-pressed')).toBe('true');
 expect(screen.getByText(/不删除会话或历史/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'自定义'}));
 const input=screen.getByRole('spinbutton');
 for(const value of ['0','31','2.5','']){
  fireEvent.change(input,{target:{value}});
  expect(screen.getByRole('button',{name:'保存接管设置'}).hasAttribute('disabled')).toBe(true);
 }
 fireEvent.change(input,{target:{value:'9'}});
 fireEvent.click(screen.getByRole('button',{name:'保存接管设置'}));
 await screen.findByText('已保存，下次闲置检查时按新设置执行。');
 expect(api.saveTakeoverPolicy).toHaveBeenCalledWith({idleDays:9,revision:0});
});
it('keeps unsaved choice on conflict and explicitly reloads the latest policy',async()=>{
 vi.mocked(api.takeoverPolicy).mockResolvedValueOnce({idleDays:14,revision:0}).mockResolvedValue({idleDays:21,revision:1});
 vi.mocked(api.saveTakeoverPolicy).mockRejectedValue(new Error('设置已在其他浏览器修改，请重新读取后保存'));
 render(<TakeoverPolicyCard/>); await screen.findByRole('button',{name:'14 天'});
 fireEvent.click(screen.getByRole('button',{name:'7 天'}));fireEvent.click(screen.getByRole('button',{name:'保存接管设置'}));
 await screen.findByRole('alert');
 expect(screen.getByRole('button',{name:'7 天'}).getAttribute('aria-pressed')).toBe('true');
 fireEvent.click(screen.getByRole('button',{name:'重新读取'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'21 天'}).getAttribute('aria-pressed')).toBe('true'));
});
it('aborts loading on unmount without submitting an update',async()=>{
 vi.mocked(api.takeoverPolicy).mockImplementation(()=>new Promise(()=>{}));
 const view=render(<TakeoverPolicyCard/>);const signal=vi.mocked(api.takeoverPolicy).mock.calls[0][0]!;
 await act(async()=>view.unmount());expect(signal.aborted).toBe(true);expect(api.saveTakeoverPolicy).not.toHaveBeenCalled();
});
