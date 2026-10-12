import test from 'node:test';
import assert from 'node:assert/strict';
import type {Browser} from 'playwright-core';
import {SharedBrowsers,parseBrowserAction} from '../src/shared-browser.js';
function fixture(){
 const operations:unknown[]=[];
 const page={on:()=>{},url:()=> 'https://example.test/',title:async()=> 'Fixture',screenshot:async()=>Buffer.from('fixture'),goto:async(url:string)=>{operations.push(url);},locator:()=>({first:()=>({click:async()=>operations.push('click'),fill:async(t:string)=>operations.push(t)}),innerText:async()=> 'Fixture',evaluateAll:async()=>[]}),mouse:{click:async()=>operations.push('click'),wheel:async()=>{}},keyboard:{insertText:async()=>{},press:async()=>{}}};
 const context={route:async()=>{},newPage:async()=>page,on:()=>{}};
 const browser={newContext:async()=>context,close:async()=>{operations.push('closed');}} as unknown as Browser;
 const browsers=new SharedBrowsers(async()=>browser);return {browsers,operations};
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
