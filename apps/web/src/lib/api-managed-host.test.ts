// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {api} from './api';
import {managedHostPlatform} from './managed-host';
afterEach(()=>vi.unstubAllGlobals());
it('preserves a stable platform independently of the OS display release from the real machine API',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({machines:[{machineId:'b52h',name:'B52H',platform:'linux',platformRelease:'26.04',architecture:'x64',reachability:'online',identityState:'active',agentVersion:'0.30.152',discovery:{state:'ready',managedProviderSupport:true}}]}),{status:200,headers:{'content-type':'application/json'}})));
 const [machine]=await api.managedHosts();
 expect(machine.platform).toBe('linux');expect(machine.os).toBe('linux 26.04');expect(managedHostPlatform(machine)).toBe('linux-x64');expect(machine.discovery?.managedProviderSupport).toBe(true);
});
