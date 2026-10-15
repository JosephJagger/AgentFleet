// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {VoiceTranscriptSearch} from './components/VoiceTranscriptSearch';
import {api} from './lib/api';
vi.mock('./lib/api',()=>({api:{voiceTranscriptSettings:vi.fn(),saveVoiceTranscriptSettings:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('explains optional keywords and call/time ranges without loading history or granting search',async()=>{
 vi.mocked(api.voiceTranscriptSettings).mockResolvedValue({enabled:false,revision:0,retentionDays:30});
 vi.mocked(api.saveVoiceTranscriptSettings).mockResolvedValue({enabled:true,revision:1,retentionDays:30});
 render(<VoiceTranscriptSearch/>);const toggle=await screen.findByRole('checkbox');await waitFor(()=>expect(toggle.hasAttribute('disabled')).toBe(false));
 expect((toggle as HTMLInputElement).checked).toBe(false);expect(api.saveVoiceTranscriptSettings).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText('保存与搜索说明'));expect(screen.getByText(/最近三次通话/)).toBeTruthy();expect(screen.getByText(/保存不等于执行/)).toBeTruthy();
 fireEvent.click(toggle);await waitFor(()=>expect(api.saveVoiceTranscriptSettings).toHaveBeenCalledWith({enabled:true,revision:0}));
});
