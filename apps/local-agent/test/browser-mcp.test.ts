import test from 'node:test';
import assert from 'node:assert/strict';
import {browserMcpUrl,closeBrowserMcp} from '../src/browser-mcp.js';

test('native MCP endpoint is loopback-only, token-bound and exposes a real tool',async t=>{
 t.after(()=>closeBrowserMcp());
 const a=await browserMcpUrl('fixture-a'),b=await browserMcpUrl('fixture-b');assert.notEqual(a,b);assert.equal(await browserMcpUrl('fixture-a'),a);
 const post=(url:string,method:string,params:unknown={},headers:Record<string,string>={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const init=await (await post(a,'initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}})).json() as {result:{capabilities:unknown}};assert.ok(init.result.capabilities);
 const tools=await (await post(a,'tools/list')).json() as {result:{tools:{name:string}[]}};assert.equal(tools.result.tools[0]?.name,'agentfleet_browser');
 assert.equal((await post(a,'tools/list',{}, {Origin:'https://untrusted.test'})).status,403);
 assert.equal((await post(a.replace(/\/[^/]+$/,'/invalid'),'tools/list')).status,403);
 const result=await (await post(b,'tools/call',{name:'agentfleet_browser',arguments:{action:'read'}})).json() as {result:{isError:boolean;content:{text:string}[]}};
 assert.equal(result.result.isError,true);assert.match(result.result.content[0]!.text,/先在面板/);
});
