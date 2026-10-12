import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CodexAppServer,type AppServerCallbacks} from '../src/app-server.js';
import {sharedBrowsers} from '../src/shared-browser.js';
import {resolveProject} from '../src/projects.js';

// No login, model request or real session. Tests the native MCP client handshake.
test('isolated native Codex discovers the optional browser MCP tool',{skip:!process.env.AGENTFLEET_NATIVE_TEST,timeout:60000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'af-browser-native-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'codex-home'),cwd=join(root,'project'),day=join(home,'sessions','2026','09','07');
 await mkdir(day,{recursive:true});await mkdir(cwd);const id=randomUUID(),at='2026-09-07T00:00:00Z';
 await writeFile(join(day,`rollout-2026-09-07T00-00-00-${id}.jsonl`),[
 {timestamp:at,type:'session_meta',payload:{id,timestamp:at,cwd,history_mode:'legacy',originator:'codex_cli_rs',cli_version:'0.160.1',source:'cli',model_provider:'openai',base_instructions:{text:'Isolated fixture. No task execution.'}}},
 {timestamp:at,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Fixture only'}]}}
 ].map(row=>JSON.stringify(row)).join('\n')+'\n');
 const callbacks:AppServerCallbacks={findManagedThread:()=>undefined,findProject:()=>undefined,onEvent:async()=>{},onVolatile:()=>{},onApproval:async()=>{},onApprovalResolved:async()=>{},onExit:async()=>{}};
 t.mock.method(sharedBrowsers,'has',(threadId:string)=>threadId===id);
 const server=new CodexAppServer(callbacks,undefined,{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,...(process.env.AGENTFLEET_NATIVE_CODEX?{AGENTFLEET_CODEX_EXECUTABLE:process.env.AGENTFLEET_NATIVE_CODEX}:{})});t.after(()=>server.stop());
 await server.start();const result=await server.resumeThread(id,await resolveProject(cwd,'fixture'));
 assert.equal(result.nativeThreadId,id);assert.equal(result.policyVerified,true);
 const rpc=server as unknown as {request:(method:string,params:Record<string,unknown>)=>Promise<unknown>};
 const status=await rpc.request('mcpServerStatus/list',{threadId:id});
 assert.match(JSON.stringify(status),/agentfleet_browser/);
 assert.match(JSON.stringify(status),/agentfleet_browser.*"inputSchema"/);
});
