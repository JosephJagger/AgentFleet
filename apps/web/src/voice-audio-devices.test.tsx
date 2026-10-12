// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {VoiceAudioDevices,voiceMicrophoneConstraints} from './components/VoiceAudioDevices';
import {VoiceTranscriptDrafts} from './components/VoiceTranscriptDrafts';
import {api} from './lib/api';
vi.mock('./lib/api',()=>({api:{voiceTranscriptTails:vi.fn(),resolveVoiceTranscriptTail:vi.fn()}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.resetAllMocks();});
it('device preview never creates a call; late microphone permission is cleaned up on dismissal',async()=>{
 let grant!:(v:MediaStream)=>void;const stop=vi.fn(),getUserMedia=vi.fn(()=>new Promise<MediaStream>(r=>{grant=r;}));
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia,enumerateDevices:vi.fn().mockResolvedValue([{kind:'audioinput',deviceId:'mic',label:'USB Mic'}])}});
 const view=render(<VoiceAudioDevices active={false} stream={null} microphone="mic" speaker="" onMicrophone={()=>undefined} onSpeaker={()=>undefined} outputSupported={false}/>);
 expect(getUserMedia).not.toHaveBeenCalled();expect(screen.getByRole('combobox',{name:'扬声器'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByText('检测麦克风'));expect(getUserMedia).toHaveBeenCalledWith(voiceMicrophoneConstraints('mic'));
 view.unmount();grant({getTracks:()=>[{stop}]} as unknown as MediaStream);await waitFor(()=>expect(stop).toHaveBeenCalledOnce());
});
it('tail review never dispatches and saving requires explicit click with reviewed text',async()=>{
 vi.mocked(api.voiceTranscriptTails).mockResolvedValue({items:[{id:'call',text:'unfinished',complete:false,revision:3,receipt:null,updatedAt:'2026-10-12'}]});
 vi.mocked(api.resolveVoiceTranscriptTail).mockResolvedValue({});
 render(<VoiceTranscriptDrafts/>);expect(api.voiceTranscriptTails).not.toHaveBeenCalled();fireEvent.click(screen.getByText('待确认转写'));
 const input=await screen.findByLabelText('核对转写内容');expect(api.resolveVoiceTranscriptTail).not.toHaveBeenCalled();
 fireEvent.change(input,{target:{value:'Reviewed instruction'}});fireEvent.click(screen.getByText('确认并保存待办'));
 await waitFor(()=>expect(api.resolveVoiceTranscriptTail).toHaveBeenCalledWith('call',{revision:3,action:'save',confirmed:true,text:'Reviewed instruction'}));
});
