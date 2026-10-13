// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {readReloadConnection,saveReloadConnection,clearReloadConnection} from './lib/reload-connections';
afterEach(()=>{sessionStorage.clear();vi.unstubAllGlobals();vi.useRealTimers();});
it('accepts only a recent reload hint, never ordinary navigation, back/forward or expired hints',()=>{
 vi.useFakeTimers();const nav={type:'navigate'};vi.stubGlobal('performance',{getEntriesByType:()=>[nav]});
 saveReloadConnection('voice','host');expect(readReloadConnection('voice')).toBe('');
 nav.type='back_forward';expect(readReloadConnection('voice')).toBe('');
 nav.type='reload';expect(readReloadConnection('voice')).toBe('host');
 vi.advanceTimersByTime(300001);expect(readReloadConnection('voice')).toBe('');
 saveReloadConnection('voice','host');clearReloadConnection('voice');expect(readReloadConnection('voice')).toBe('');
});
