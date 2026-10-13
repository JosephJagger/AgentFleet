import {expect,it} from 'vitest';
import {windowsBroadcastLauncher} from './broadcast-launcher';
it('creates an isolated app window with background rendering flags and no credentials or inherited URL parameters',()=>{
 const script=windowsBroadcastLauncher('https://example.test:8443/private?token=secret#fragment');
 expect(script).toContain('--app=https://example.test:8443/workbench?broadcast=1');
 expect(script).toContain('--user-data-dir=%LOCALAPPDATA%\\AgentFleets\\BroadcastProfile');
 for(const flag of ['disable-backgrounding-occluded-windows','disable-background-timer-throttling','disable-renderer-backgrounding'])expect(script).toContain('--'+flag);
 expect(script).not.toContain('secret');expect(script).not.toContain('no-sandbox');expect(script).not.toContain('disable-web-security');
 expect(script).toContain('msedge.exe');expect(script).toContain('chrome.exe');expect(script).toContain('\r\n');
});
it('rejects non-web URLs, credentials and shell metacharacters in origins',()=>{
 for(const input of ['file:///x','javascript:alert(1)','https://name:password@example.test','https://evil%22.example','https://%25PATH%25.example','https://evil&whoami.example'])expect(()=>windowsBroadcastLauncher(input)).toThrow();
});
