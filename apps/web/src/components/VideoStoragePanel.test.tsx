// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { VideoStoragePanel } from './VideoStoragePanel';
import { api } from '../lib/api';
vi.mock('../lib/api', () => ({api:{videoStorage:vi.fn(),deleteVideo:vi.fn(),downloadVideo:vi.fn()}}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const item={key:'grok-videos/test.mp4',bytes:42,etag:'"abc"',modifiedAt:'2026-10-19T00:00:00Z',canDelete:true};
const page={configured:true,label:'B52H',quotaBytes:5e9,items:[item],nextCursor:null};
it('requires explicit confirmation, sends exact snapshot and refreshes after deletion',async()=>{
 vi.mocked(api.videoStorage).mockResolvedValue(page);vi.mocked(api.deleteVideo).mockResolvedValue({deleted:true});render(<VideoStoragePanel/>);
 fireEvent.click(await screen.findByRole('button',{name:'删除'}));expect(api.deleteVideo).not.toHaveBeenCalled();
 expect(screen.getByRole('alertdialog')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(api.deleteVideo).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'删除'}));fireEvent.click(screen.getByRole('button',{name:'确认删除'}));
 await waitFor(()=>expect(api.deleteVideo).toHaveBeenCalledWith(item));await waitFor(()=>expect(api.videoStorage).toHaveBeenCalledTimes(2));
});
it('paginates explicitly, shows errors and keeps recent objects protected',async()=>{
 vi.mocked(api.videoStorage).mockResolvedValueOnce({...page,items:[{...item,canDelete:false}],nextCursor:'second'}).mockRejectedValueOnce(new Error('unavailable'));
 render(<VideoStoragePanel/>);expect((await screen.findByRole('button',{name:'删除'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'下一页'}));await screen.findByRole('alert');expect(api.videoStorage).toHaveBeenLastCalledWith('second',expect.any(AbortSignal));
});
it('does not claim unconfigured storage is empty usable storage',async()=>{
 vi.mocked(api.videoStorage).mockResolvedValue({configured:false,items:[],nextCursor:null});render(<VideoStoragePanel/>);
 expect(await screen.findByText('此工作区尚未配置视频存储')).toBeTruthy();expect(screen.queryByRole('button',{name:'删除'})).toBeNull();
});
