import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
import {SharedBrowsers} from '../src/shared-browser.js';

test('isolated Chromium: shared page, human input, approved AI action and takeover',{skip:process.env.AGENTFLEET_BROWSER_TEST!=='1'},async t=>{
 const site=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><title>Collaboration fixture</title><label>Name <input id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Save draft</button><p id="result">Nothing saved</p>');});
 await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>((resolve,reject)=>site.close(e=>e?reject(e):resolve())));
 // This test visits only a synthetic local page. Production always enables Chromium sandboxing.
 const browsers=new SharedBrowsers(()=>chromium.launch({headless:true,executablePath:process.env.AGENTFLEET_TEST_CHROMIUM??chromium.executablePath(),chromiumSandbox:process.getuid?.()!==0}));t.after(()=>browsers.stop());
 assert.deepEqual(await browsers.control('fixture',{action:'status'}),{state:'closed'});
 await browsers.control('fixture',{action:'open'});
 assert.deepEqual(await browsers.control('fixture',{action:'status'}),{state:'open'});
 let frame=await browsers.snapshot('fixture');
 await browsers.control('fixture',{action:'navigate',url:`http://127.0.0.1:${(site.address() as {port:number}).port}`,key:'navigate',revision:frame.revision});
 frame=await browsers.snapshot('fixture');assert.equal(frame.title,'Collaboration fixture');assert.ok(frame.image.startsWith('data:image/jpeg;base64,'));
 assert.ok(Buffer.byteLength(JSON.stringify({type:'browser.result',requestId:'fixture',result:frame}))<1_000_000);
 // A re-open only reattaches to this thread's existing page, preserving its state.
 const recovered=await browsers.control('fixture',{action:'open'});assert.equal((recovered as {url:string}).url,frame.url);
 await browsers.control('fixture',{action:'click',selector:'#name',key:'focus',revision:frame.revision});frame=await browsers.snapshot('fixture');
 await browsers.control('fixture',{action:'fill',text:'Verified draft',key:'fill',revision:frame.revision});frame=await browsers.snapshot('fixture');
 await browsers.control('fixture',{action:'handoff',key:'handoff',revision:frame.revision});
 assert.match(JSON.stringify(await browsers.tool('fixture',{action:'read'})),/Nothing saved/);
 const pending=browsers.tool('fixture',{action:'click',selector:'#save'});frame=await browsers.snapshot('fixture');assert.ok(frame.pending);
 assert.match(JSON.stringify(await browsers.tool('fixture',{action:'read'})),/Nothing saved/);
 await browsers.control('fixture',{action:'approve',key:'approve',revision:frame.revision,pendingId:frame.pending!.id});await pending;
 assert.match(JSON.stringify(await browsers.tool('fixture',{action:'read'})),/Verified draft/);
 frame=await browsers.snapshot('fixture');await browsers.control('fixture',{action:'takeover',key:'takeover',revision:frame.revision});
 await assert.rejects(()=>browsers.tool('fixture',{action:'read'}),/用户正在操作/);
 await browsers.control('fixture',{action:'close'});assert.deepEqual(await browsers.control('fixture',{action:'status'}),{state:'closed'});
});
