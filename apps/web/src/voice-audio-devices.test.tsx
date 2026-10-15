// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {VoiceAudioDevices,voiceMicrophoneConstraints} from './components/VoiceAudioDevices';
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.resetAllMocks();});
it('device preview never creates a call; late microphone permission is cleaned up on dismissal',async()=>{
 let grant!:(v:MediaStream)=>void;const stop=vi.fn(),getUserMedia=vi.fn(()=>new Promise<MediaStream>(r=>{grant=r;}));
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia,enumerateDevices:vi.fn().mockResolvedValue([{kind:'audioinput',deviceId:'mic',label:'USB Mic'}])}});
 const view=render(<VoiceAudioDevices active={false} stream={null} microphone="mic" speaker="" onMicrophone={()=>undefined} onSpeaker={()=>undefined} outputSupported={false}/>);
 expect(getUserMedia).not.toHaveBeenCalled();expect(screen.getByRole('combobox',{name:'扬声器'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByText('检测麦克风'));expect(getUserMedia).toHaveBeenCalledWith(voiceMicrophoneConstraints('mic'));
 view.unmount();grant({getTracks:()=>[{stop}]} as unknown as MediaStream);await waitFor(()=>expect(stop).toHaveBeenCalledOnce());
});
