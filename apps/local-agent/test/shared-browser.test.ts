import test from 'node:test';
import assert from 'node:assert/strict';
import type {Browser} from 'playwright-core';
import {SharedBrowsers,parseBrowserAction} from '../src/shared-browser.js';
import {AgentError} from '../src/errors.js';
function fixture(){
 const operations:unknown[]=[];
 const page={on:()=>{},isClosed:()=>false,url:()=> 'https://example.test/',title:async()=> 'Fixture',screenshot:async()=>Buffer.from('fixture'),goto:async(url:string)=>{operations.push(url);},locator:()=>({first:()=>({click:async()=>operations.push('click'),fill:async(t:string)=>operations.push(t)}),innerText:async()=> 'Fixture',evaluateAll:async()=>[]}),mouse:{click:async()=>operations.push('click'),wheel:async()=>{}},keyboard:{insertText:async()=>{},press:async()=>{}}};
 const context={route:async()=>{},newPage:async()=>page,on:()=>{}};
 const browser={newContext:async()=>context,isConnected:()=>true,on:()=>{},close:async()=>{operations.push('closed');}} as unknown as Browser;
 const browsers=new SharedBrowsers(async()=>browser);return {browsers,operations,browser,page};
}
test('blocks file URLs, credentials and invalid actions',()=>{
 for(const url of ['file:///etc/passwd','javascript:alert(1)','https://user:pass@example.test'])assert.throws(()=>parseBrowserAction({action:'navigate',url}));
 assert.throws(()=>parseBrowserAction({action:'click',x:-1,y:1}));assert.throws(()=>parseBrowserAction({action:'key',text:'Control+O'}));
});
test('AI cannot operate before handoff; takeover cancels pending operation',async t=>{
 const {browsers,operations}=fixture();t.after(()=>browsers.stop());await browsers.control('a',{action:'open'});
 await assert.rejects(()=>browsers.tool('a',{action:'read'}),/用户正在操作/);
 await browsers.control('a',{action:'handoff',key:'handoff',revision:1});
 const proposal=browsers.tool('a',{action:'navigate',url:'https://example.test'});
 const frame=await browsers.snapshot('a');assert.ok(frame.pending);assert.equal(operations.length,0);
 await browsers.control('a',{action:'takeover',key:'take',revision:frame.revision});assert.match(JSON.stringify(await proposal),/未执行/);assert.equal(operations.length,0);
 await assert.rejects(()=>browsers.control('a',{action:'approve',key:'stale',revision:frame.revision,pendingId:frame.pending!.id}),/已变化/);
});
test('approved operation happens once and response retry never repeats it',async t=>{
 const {browsers,operations}=fixture();t.after(()=>browsers.stop());await browsers.control('a',{action:'open'});await browsers.control('a',{action:'handoff',key:'handoff',revision:1});
 const proposal=browsers.tool('a',{action:'navigate',url:'https://example.test'}),frame=await browsers.snapshot('a');
 const input={action:'approve',key:'approve',revision:frame.revision,pendingId:frame.pending!.id};
 await browsers.control('a',input);await proposal;await browsers.control('a',input);assert.deepEqual(operations,['https://example.test/']);
 await assert.rejects(()=>browsers.control('a',{...input,pendingId:'other'}),/已被使用/);
});
test('disconnect fences AI and browser contexts do not cross session identities',async t=>{
 const {browsers}=fixture();t.after(()=>browsers.stop());await browsers.control('a',{action:'open'});await browsers.control('a',{action:'handoff',key:'handoff',revision:1});
 const pending=browsers.tool('a',{action:'click',x:50,y:50});browsers.disconnect();assert.match(JSON.stringify(await pending),/连接中断/);
 await assert.rejects(()=>browsers.tool('a',{action:'read'}),/用户正在操作/);await assert.rejects(()=>browsers.tool('b',{action:'read'}),/先在面板/);
 await browsers.control('a',{action:'close'});assert.equal(browsers.has('a'),false);
});

test('closing during launch cannot resurrect an unwanted browser',async t=>{
 const f=fixture();let resume!:(value:Browser)=>void;const source=new Promise<Browser>(resolve=>{resume=resolve;});
 let closed=0;const browser={newContext:async()=>({route:async()=>{},newPage:async()=>({on:()=>{}}),on:()=>{}}),close:async()=>{closed++;}} as unknown as Browser;
 const browsers=new SharedBrowsers(()=>source);t.after(()=>browsers.stop());t.after(()=>f.browsers.stop());
 const opening=browsers.control('a',{action:'open'});await browsers.control('a',{action:'close'});resume(browser);
 await assert.rejects(opening,/取消/);assert.equal(browsers.has('a'),false);assert.equal(closed,1);
});
test('lost panel heartbeat denies AI input even while the native task continues',async t=>{
 t.mock.timers.enable({apis:['Date']});const {browsers}=fixture();t.after(()=>browsers.stop());
 await browsers.control('a',{action:'open'});await browsers.control('a',{action:'handoff',key:'handoff',revision:1});
 t.mock.timers.tick(31000);await assert.rejects(()=>browsers.tool('a',{action:'read'}),/面板未连接/);
 await browsers.snapshot('a');await browsers.tool('a',{action:'read'});
 browsers.setAccessGuard('a',()=>{throw new Error('revoked');});await assert.rejects(()=>browsers.tool('a',{action:'read'}),/revoked/);
});

test('status never launches a browser, renews the panel heartbeat or changes control',async t=>{
 t.mock.timers.enable({apis:['Date']});const {browsers,operations}=fixture();t.after(()=>browsers.stop());
 assert.deepEqual(await browsers.control('a',{action:'status'}),{state:'closed'});assert.deepEqual(operations,[]);
 await browsers.control('a',{action:'open'});await browsers.control('a',{action:'handoff',key:'handoff',revision:1});
 t.mock.timers.tick(31_000);assert.deepEqual(await browsers.control('a',{action:'status'}),{state:'open'});
 await assert.rejects(()=>browsers.tool('a',{action:'read'}),/面板未连接/);
 const frame=await browsers.snapshot('a');assert.equal(frame.mode,'agent');assert.equal(frame.revision,2);
 await browsers.control('a',{action:'close'});assert.deepEqual(browsers.status('a'),{state:'closed'});
});

test('startup has a total deadline, reports failure and closes a late browser without resurrecting it',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();t.after(()=>f.browsers.stop());
 let resume!:(value:Browser)=>void;const browsers=new SharedBrowsers(()=>new Promise(resolve=>{resume=resolve;}));t.after(()=>browsers.stop());
 const opening=browsers.control('a',{action:'open'});assert.deepEqual(browsers.status('a'),{state:'opening'});
 const failure=assert.rejects(opening,(error:unknown)=>error instanceof AgentError&&error.code==='BROWSER_START_TIMEOUT');
 t.mock.timers.tick(20_000);await failure;assert.equal(browsers.status('a').state,'failed');assert.equal(browsers.status('a').code,'BROWSER_START_TIMEOUT');
 resume(f.browser);await Promise.resolve();await Promise.resolve();assert.equal(browsers.has('a'),false);assert.deepEqual(f.operations,['closed']);
 await browsers.close('a');assert.deepEqual(browsers.status('a'),{state:'closed'});
});

test('startup preview timeout cleans the browser and retains a specific failure',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();t.after(()=>f.browsers.stop());
 f.page.screenshot=()=>new Promise(()=>{});
 const opening=f.browsers.control('a',{action:'open'});
 for(let i=0;i<10;i++)await Promise.resolve();
 const failure=assert.rejects(opening,(error:unknown)=>error instanceof AgentError&&error.code==='BROWSER_PREVIEW_TIMEOUT');
 t.mock.timers.tick(5_000);await failure;assert.equal(f.browsers.status('a').code,'BROWSER_PREVIEW_TIMEOUT');assert.deepEqual(f.operations,['closed']);
});

test('launch failures are safe and specific without exposing browser diagnostics',async t=>{
 const browsers=new SharedBrowsers(async()=>{throw new Error('Chromium sandbox failed, secret profile: /private/user');});t.after(()=>browsers.stop());
 await assert.rejects(()=>browsers.control('a',{action:'open'}),(error:unknown)=>error instanceof AgentError&&error.code==='BROWSER_SANDBOX_UNAVAILABLE'&&!error.message.includes('/private/user'));
 assert.deepEqual(browsers.status('a'),{state:'failed',code:'BROWSER_SANDBOX_UNAVAILABLE',error:'主机浏览器沙箱不可用，请检查系统权限；未降低安全限制'});
});

test('preview budget compresses frames and rejects oversized images before relay transport',async t=>{
 const f=fixture();t.after(()=>f.browsers.stop());let shots=0;
 f.page.screenshot=async()=>Buffer.alloc(++shots===1?700_000:100_000);
 const frame=await f.browsers.control('a',{action:'open'});assert.ok(Buffer.byteLength(JSON.stringify({type:'browser.result',requestId:'id',result:frame}))<1_000_000);assert.equal(shots,2);
 f.page.screenshot=async()=>Buffer.alloc(700_000);
 await assert.rejects(()=>f.browsers.snapshot('a'),(error:unknown)=>error instanceof AgentError&&error.code==='BROWSER_PREVIEW_TOO_LARGE');assert.equal(f.browsers.status('a').state,'open');
});

test('stop cancels pending startup, rejects new opens and cannot revive from a late launch',async t=>{
 const f=fixture();t.after(()=>f.browsers.stop());let resume!:(value:Browser)=>void;
 const browsers=new SharedBrowsers(()=>new Promise(resolve=>{resume=resolve;}));t.after(()=>browsers.stop());
 const opening=browsers.control('a',{action:'open'});const cancelled=assert.rejects(opening,/取消/);await browsers.stop();await cancelled;
 await assert.rejects(()=>browsers.control('a',{action:'open'}),(error:unknown)=>error instanceof AgentError&&error.code==='BROWSER_STOPPED');
 resume(f.browser);await Promise.resolve();await Promise.resolve();assert.deepEqual(browsers.status('a'),{state:'closed'});assert.deepEqual(f.operations,['closed']);
});

test('retry attaches to the same live browser and an old cancelled launch cannot replace it',async t=>{
 const old=fixture(),current=fixture();t.after(()=>old.browsers.stop());t.after(()=>current.browsers.stop());
 let resume!:(value:Browser)=>void,launches=0;
 const browsers=new SharedBrowsers(()=>++launches===1?new Promise(resolve=>{resume=resolve;}):Promise.resolve(current.browser));t.after(()=>browsers.stop());
 const opening=browsers.control('a',{action:'open'}),cancelled=assert.rejects(opening,/取消/);
 await browsers.close('a');await cancelled;await browsers.control('a',{action:'open'});await browsers.control('a',{action:'open'});assert.equal(launches,2);
 resume(old.browser);await Promise.resolve();await Promise.resolve();assert.deepEqual(old.operations,['closed']);assert.deepEqual(current.operations,[]);assert.deepEqual(browsers.status('a'),{state:'open'});
});

test('uncertain operation timeout is redacted and a transport retry cannot execute again',async t=>{
 const f=fixture();t.after(()=>f.browsers.stop());await f.browsers.control('a',{action:'open'});let calls=0;
 f.page.goto=async()=>{calls++;throw new Error('Timeout navigating https://private.test/?token=secret');};
 const input={action:'navigate',url:'https://example.test',key:'navigate',revision:1};
 await assert.rejects(()=>f.browsers.control('a',input),(error:unknown)=>error instanceof AgentError&&error.code==='BROWSER_ACTION_TIMEOUT'&&!error.message.includes('secret'));
 assert.deepEqual(await f.browsers.control('a',input),{uncertain:true});assert.equal(calls,1);
});

test('a browser disconnected during initial preview is not published as open',async t=>{
 const f=fixture();t.after(()=>f.browsers.stop());t.mock.method(f.browser,'isConnected',()=>false);
 await assert.rejects(()=>f.browsers.control('a',{action:'open'}),(error:unknown)=>error instanceof AgentError&&error.code==='BROWSER_DISCONNECTED');
 assert.equal(f.browsers.has('a'),false);assert.equal(f.browsers.status('a').state,'failed');assert.deepEqual(f.operations,['closed']);
});
