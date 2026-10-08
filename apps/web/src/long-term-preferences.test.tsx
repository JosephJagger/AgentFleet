// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {LongTermPreferencesPanel} from './components/LongTermPreferencesPanel';
import {api} from './lib/api';
vi.mock('./lib/api',()=>({api:{longTermPreferences:vi.fn(),saveLongTermPreference:vi.fn(),deleteLongTermPreference:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const record={id:'english',body:'Correct English first',conditions:'When I speak English',enabled:true,expiresAt:null,revision:1};
const page={items:[record],revision:1,bytes:120,budget:8192};
it('shows preserved conditions, saves a replacement revision, and deletes only on explicit confirmation',async()=>{
 vi.mocked(api.longTermPreferences).mockResolvedValue(page);
 vi.mocked(api.saveLongTermPreference).mockResolvedValue({...page,revision:2});
 vi.mocked(api.deleteLongTermPreference).mockResolvedValue({...page,revision:3,items:[]});
 render(<LongTermPreferencesPanel/>);
 expect(await screen.findByText('Correct English first')).toBeTruthy();
 expect(screen.getByText('适用条件：When I speak English')).toBeTruthy();
 fireEvent.click(screen.getByText('编辑'));
 fireEvent.change(screen.getByLabelText('偏好规则'),{target:{value:'Correct only when asked'}});
 fireEvent.click(screen.getByText('保存偏好'));
 await waitFor(()=>expect(api.saveLongTermPreference).toHaveBeenCalledWith(expect.objectContaining({body:'Correct only when asked',conditions:'When I speak English',revision:1}),'english'));
 fireEvent.click(screen.getByText('删除'));expect(api.deleteLongTermPreference).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText('确认删除'));
 await waitFor(()=>expect(api.deleteLongTermPreference).toHaveBeenCalledWith('english',1));
 expect(await screen.findByText('暂无长期偏好。添加明确的行为规则后，下次通话会自动加载。')).toBeTruthy();
});
it('capacity errors keep the full unsaved text for correction',async()=>{
 vi.mocked(api.longTermPreferences).mockResolvedValue(page);
 vi.mocked(api.saveLongTermPreference).mockRejectedValue(new Error('容量超限'));
 render(<LongTermPreferencesPanel/>);await screen.findByText('Correct English first');
 fireEvent.click(screen.getByText('添加偏好'));fireEvent.change(screen.getByLabelText('偏好规则'),{target:{value:'Keep exact meaning and exceptions'}});
 fireEvent.click(screen.getByText('保存偏好'));
 expect(await screen.findByRole('alert')).toBeTruthy();
 expect((screen.getByLabelText('偏好规则') as HTMLTextAreaElement).value).toBe('Keep exact meaning and exceptions');
});
