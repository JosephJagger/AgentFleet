// @vitest-environment jsdom
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const status=(csrfToken='old',clientSessionId='session-a')=>({authenticated:true,csrfToken,clientSessionId,user:{userId:'user-a',email:'a@example.test'}});
beforeEach(()=>{vi.resetModules();localStorage.clear();});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
async function setup(){
 const fetch=vi.fn(async(path:string,_init?:RequestInit)=>json(path==='/api/auth/status'?status():{}));vi.stubGlobal('fetch',fetch);
 const {api}=await import('./api');await api.dashboard();fetch.mockReset();return {api,fetch};
}
it('recovers a rejected write once with the same body and refreshed token',async()=>{
 const {api,fetch}=await setup();
 fetch.mockResolvedValueOnce(json({error:{code:'CSRF_INVALID',message:'stale'}},403)).mockResolvedValueOnce(json(status('recovered'))).mockResolvedValueOnce(json({ok:true}));
 const body={settings:null,revision:2};await api.saveMachineCodexPreferences('host',body);
 expect(fetch).toHaveBeenCalledTimes(3);
 expect(fetch.mock.calls[1][0]).toBe('/api/auth/status');
 const calls=fetch.mock.calls as unknown as [string,RequestInit][];
 expect(new Headers(calls[0][1].headers).get('x-csrf-token')).toBe('old');
 expect(new Headers(calls[2][1].headers).get('x-csrf-token')).toBe('recovered');
 expect(calls[2][0]).toBe(calls[0][0]);expect(calls[2][1].body).toBe(calls[0][1].body);
 expect(localStorage.getItem('agentfleet.csrf')).toBe('recovered');
});
it('stops after one failed CSRF retry and preserves the live logout credential',async()=>{
 const {api,fetch}=await setup();
 fetch.mockResolvedValueOnce(json({error:{code:'CSRF_INVALID'}},403)).mockResolvedValueOnce(json(status('recovered'))).mockResolvedValueOnce(json({error:{code:'CSRF_INVALID'}},403));
 await expect(api.logout()).rejects.toMatchObject({code:'CSRF_INVALID'});
 expect(fetch).toHaveBeenCalledTimes(3);expect(localStorage.getItem('agentfleet.csrf')).toBe('recovered');
 fetch.mockResolvedValueOnce(json({ok:true}));await api.logout();expect(localStorage.getItem('agentfleet.csrf')).toBeNull();
});
it('does not retry a write under a changed login session',async()=>{
 const {api,fetch}=await setup();
 fetch.mockResolvedValueOnce(json({error:{code:'CSRF_INVALID'}},403)).mockResolvedValueOnce(json(status('new-account-token','session-b')));
 await expect(api.saveMachineCodexPreferences('host',{settings:null,revision:2})).rejects.toMatchObject({code:'AUTH_SESSION_CHANGED'});
 expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([403,500])('does not retry unrelated HTTP %s failures or clear credentials after failed logout',async code=>{
 const {api,fetch}=await setup();fetch.mockResolvedValueOnce(json({error:{code:'OTHER_ERROR'}},code));
 await expect(api.logout()).rejects.toMatchObject({code:'OTHER_ERROR'});expect(fetch).toHaveBeenCalledTimes(1);expect(localStorage.getItem('agentfleet.csrf')).toBe('old');
});
it('cookie login and logout still work with blocked browser storage',async()=>{
 vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw Error('blocked');});
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('blocked');});
 vi.spyOn(Storage.prototype,'removeItem').mockImplementation(()=>{throw Error('blocked');});
 const {api,fetch}=await setup();fetch.mockResolvedValueOnce(json({ok:true}));await api.logout();
 const calls=fetch.mock.calls as unknown as [string,RequestInit][];
 expect(new Headers(calls[0][1].headers).get('x-csrf-token')).toBe('old');
});
it('treats an already expired session as logged out',async()=>{
 const {api,fetch}=await setup();fetch.mockResolvedValueOnce(json({error:{code:'SESSION_INVALID'}},401));await api.logout();expect(localStorage.getItem('agentfleet.csrf')).toBeNull();
});
it('refreshing dashboard restores a missing token without a write or re-login',async()=>{
 const {api,fetch}=await setup();localStorage.removeItem('agentfleet.csrf');
 fetch.mockImplementation(async path=>json(path==='/api/auth/status'?status('restored'):{}));await api.dashboard();expect(localStorage.getItem('agentfleet.csrf')).toBe('restored');
 expect(fetch.mock.calls.every(([,options])=>!options || !('method' in options))).toBe(true);
});
it('reads current login state without cache and bounds dashboard requests',async()=>{
 const {api,fetch}=await setup();
 fetch.mockImplementation(async path=>json(path==='/api/auth/status'?status():{}));
 await api.dashboard();
 for(const [,options] of fetch.mock.calls){
  expect(options?.cache).toBe('no-store');
  expect(options?.signal).toBeDefined();
 }
});
it.each([{}, {authenticated:'false'}])('invalid status payload is a connection error, not a logout: %j',async payload=>{
 const {api,fetch}=await setup();fetch.mockResolvedValueOnce(json(payload));
 await expect(api.dashboard()).rejects.toMatchObject({status:502,code:'INVALID_RESPONSE'});
 expect(localStorage.getItem('agentfleet.csrf')).toBe('old');
});
it('explicit unauthenticated status still requires sign-in',async()=>{
 const {api,fetch}=await setup();fetch.mockResolvedValueOnce(json({authenticated:false}));
 await expect(api.dashboard()).rejects.toMatchObject({status:401,code:'AUTH_REQUIRED'});
 expect(localStorage.getItem('agentfleet.csrf')).toBeNull();
});
