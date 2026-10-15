// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {VoiceTranscriptSearch} from './VoiceTranscriptSearch';
import {api} from '../lib/api';
vi.mock('../lib/api',()=>({api:{voiceTranscriptSettings:vi.fn(),saveVoiceTranscriptSettings:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('loads only permission, saves opt-in with revision, and removes old draft confirmation',async()=>{
 vi.mocked(api.voiceTranscriptSettings).mockResolvedValue({enabled:false,revision:0,retentionDays:30});
 vi.mocked(api.saveVoiceTranscriptSettings).mockResolvedValue({enabled:true,revision:1,retentionDays:30});
 render(<VoiceTranscriptSearch/>);const checkbox=screen.getByRole('checkbox',{name:'支持搜索转写'}) as HTMLInputElement;
 await waitFor(()=>expect(checkbox.disabled).toBe(false));expect(checkbox.checked).toBe(false);
 expect(screen.queryByText('待确认转写')).toBeNull();expect(screen.queryByRole('textbox')).toBeNull();
 fireEvent.click(checkbox);await waitFor(()=>expect(api.saveVoiceTranscriptSettings).toHaveBeenCalledWith({enabled:true,revision:0}));
 await waitFor(()=>expect(checkbox.checked).toBe(true));expect(screen.getByText(/关闭搜索仍会保存/)).toBeTruthy();
});
it('does not show an unsaved checkbox as enabled after a save conflict',async()=>{
 vi.mocked(api.voiceTranscriptSettings).mockResolvedValue({enabled:false,revision:2,retentionDays:30});vi.mocked(api.saveVoiceTranscriptSettings).mockRejectedValue(new Error('conflict'));
 render(<VoiceTranscriptSearch/>);const checkbox=screen.getByRole('checkbox') as HTMLInputElement;await waitFor(()=>expect(checkbox.disabled).toBe(false));fireEvent.click(checkbox);
 expect(await screen.findByRole('alert')).toBeTruthy();await waitFor(()=>expect(checkbox.disabled).toBe(false));expect(checkbox.checked).toBe(false);
});
