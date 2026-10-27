// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GlobalSessionSearch, type SessionSearchItem, type SessionSearchPage } from './GlobalSessionSearch';
import { api } from '../lib/api';
import { setLocale } from '../i18n';
import type { Machine } from '../lib/types';

vi.mock('../lib/api',()=>({api:{searchSessions:vi.fn()}}));
const hosts=[{id:'remote',name:'B2A'},{id:'local',name:'CVN-78'}] as Machine[];
const item:SessionSearchItem={id:'ls_remote',title:'权限排查',machineId:'remote',machineName:'B2A',projectId:'p',project:'HeraLens',path:'/opt/HeraLens',provider:'claude',managed:true,online:false,state:'idle',updatedAt:'2026-10-26T00:00:00Z',contentAvailable:true,match:'message',snippet:'之前的 SSH 权限配置',messageRole:'user'};
const page=(items=[item],overrides:Partial<SessionSearchPage>={}):SessionSearchPage=>({items,total:items.length,nextOffset:null,query:'SSH',terms:['ssh'],mode:'keyword_fuzzy',contentStatus:'searched',...overrides});
beforeEach(()=>{
  setLocale('zh-CN');
  HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
});
afterEach(()=>{cleanup();vi.resetAllMocks();setLocale('zh-CN');});

it('opens cross-host results with provenance and snippets, safely highlights plain text and selects exact session',async()=>{
  vi.mocked(api.searchSessions).mockResolvedValue(page([{...item,snippet:'SSH <img src=x onerror=alert(1)>'}]));
  const select=vi.fn(),close=vi.fn();render(<GlobalSessionSearch machines={hosts} initialQuery="SSH" onClose={close} onSelect={select}/>);
  const input=screen.getByRole('combobox',{name:'搜索全部会话'});expect(document.activeElement).toBe(input);
  const result=await screen.findByRole('option',{name:/权限排查/});
  expect(result.textContent).toContain('B2A · Claude Code · HeraLens');expect(result.textContent).toContain('正文命中 · 离线');expect(result.querySelector('mark')?.textContent).toBe('SSH');expect(result.querySelector('img')).toBeNull();
  fireEvent.click(result);expect(select.mock.calls[0][0].id).toBe(item.id);expect(close).toHaveBeenCalledOnce();
  expect(api.searchSessions).toHaveBeenCalledWith({q:'SSH',offset:0},expect.any(AbortSignal));
});

it('supports keyboard selection and does not open during Chinese composition',async()=>{
  vi.mocked(api.searchSessions).mockResolvedValue(page([item,{...item,id:'ls_other',title:'另一个会话'}]));
  const select=vi.fn();render(<GlobalSessionSearch machines={hosts} onClose={()=>{}} onSelect={select}/>);
  await screen.findByRole('option',{name:/权限排查/});const input=screen.getByRole('combobox',{name:'搜索全部会话'});
  fireEvent.keyDown(input,{key:'ArrowDown'});expect(within(screen.getByRole('listbox')).getByRole('option',{selected:true}).textContent).toContain('另一个会话');
  fireEvent.compositionStart(input);fireEvent.keyDown(input,{key:'Enter',isComposing:true});expect(select).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);fireEvent.keyDown(input,{key:'Enter'});expect(select.mock.calls[0][0].id).toBe('ls_other');
});

it('aborts superseded requests and hides stale results while the new query loads',async()=>{
  let resolveOld!:(page:SessionSearchPage)=>void;
  vi.mocked(api.searchSessions).mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockResolvedValue(page([{...item,id:'new',title:'新结果'}]));
  render(<GlobalSessionSearch machines={hosts} onClose={()=>{}} onSelect={()=>{}}/>);
  await waitFor(()=>expect(api.searchSessions).toHaveBeenCalledOnce());const oldSignal=vi.mocked(api.searchSessions).mock.calls[0][1]!;
  fireEvent.change(screen.getByRole('combobox',{name:'搜索全部会话'}),{target:{value:'new'}});expect(oldSignal.aborted).toBe(true);
  await screen.findByRole('option',{name:/新结果/});resolveOld(page());
  await waitFor(()=>expect(screen.queryByRole('option',{name:/权限排查/})).toBeNull());
});

it('filters on server, paginates without duplicates, and explains unavailable message search',async()=>{
  vi.mocked(api.searchSessions).mockResolvedValueOnce(page([item],{nextOffset:20,total:21})).mockResolvedValueOnce(page([item,{...item,id:'second',title:'另一页'}],{total:21})).mockResolvedValue(page([],{contentStatus:'unavailable'}));
  render(<GlobalSessionSearch machines={hosts} onClose={()=>{}} onSelect={()=>{}}/>);
  fireEvent.click(await screen.findByRole('button',{name:'加载更多会话'}));await screen.findByRole('option',{name:/另一页/});expect(within(screen.getByRole('listbox')).getAllByRole('option',{selected:false})).toHaveLength(1);
  fireEvent.change(screen.getByRole('combobox',{name:'搜索范围：主机'}),{target:{value:'remote'}});
  await waitFor(()=>expect(api.searchSessions).toHaveBeenLastCalledWith({q:'',machineId:'remote',offset:0},expect.any(AbortSignal)));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('正文搜索暂未完成'));
  fireEvent.click(screen.getByRole('checkbox',{name:'仅已接管'}));await waitFor(()=>expect(api.searchSessions).toHaveBeenLastCalledWith({q:'',machineId:'remote',managed:true,offset:0},expect.any(AbortSignal)));
});

it('English labels stay separate from native project and provider names',async()=>{
  setLocale('en');vi.mocked(api.searchSessions).mockResolvedValue(page([{...item,contentAvailable:false,snippet:'',match:'title'}]));
  render(<GlobalSessionSearch machines={hosts} onClose={()=>{}} onSelect={()=>{}}/>);
  expect(screen.getByRole('heading',{name:'Search all conversations'})).toBeTruthy();expect((await screen.findByRole('option',{name:/权限排查/})).textContent).toContain('Title and project only');expect(screen.getByText(/B2A · Claude Code · HeraLens/)).toBeTruthy();
});
