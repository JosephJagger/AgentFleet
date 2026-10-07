import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CodexAppServer,type AppServerCallbacks} from '../src/app-server.js';
// Isolated synthetic native rollout. Reads do not create turns or contact a model.
test('real native service reads a completed on-disk conversation without starting/resuming it',{skip:!process.env.AGENTFLEET_HISTORY_NATIVE_TEST,timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'readonly-history-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'home'),cwd=join(root,'project'),sessions=join(home,'sessions','2026','01','01');await mkdir(sessions,{recursive:true});await mkdir(cwd);
 const id=randomUUID(),turn=randomUUID(),at='2026-01-01T00:00:00.000Z';
 const rows=[{type:'session_meta',payload:{id,timestamp:at,cwd,originator:'codex_cli_rs',cli_version:'0.160.1',source:'cli',model_provider:'openai'}},
 {type:'event_msg',payload:{type:'task_started',turn_id:turn}},
 {type:'event_msg',payload:{type:'user_message',message:'Synthetic historical question',images:[],local_images:[],text_elements:[]}},
 {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Synthetic historical question'}]}},
 {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Synthetic final reply'}]}},
 {type:'event_msg',payload:{type:'agent_message',message:'Synthetic final reply',phase:'final_answer'}},
 {type:'event_msg',payload:{type:'task_complete',turn_id:turn,last_agent_message:'Synthetic final reply'}}];
 const file=join(sessions,`rollout-2026-01-01T00-00-00-${id}.jsonl`),original=rows.map(r=>JSON.stringify({timestamp:at,...r})).join('\n')+'\n';await writeFile(file,original);
 const callbacks={findManagedThread:()=>undefined,findProject:()=>undefined,onEvent:async()=>{throw Error('Read unexpectedly emitted task event');},onVolatile:()=>undefined,onApproval:async()=>{throw Error('Read requested approval');},onApprovalResolved:async()=>undefined,onExit:async()=>undefined} as AppServerCallbacks;
 const server=new CodexAppServer(callbacks,undefined,{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,AGENTFLEET_CODEX_EXECUTABLE:process.env.AGENTFLEET_NATIVE_CODEX});
 try {await server.start();const result=await server.readConversation(id,null);assert.equal(result.nativeThreadId,id);assert.equal(result.turnId,turn);assert.ok(result.items.some(i=>i.role==='user'&&i.text==='Synthetic historical question'));assert.ok(result.items.some(i=>i.role==='assistant'&&i.text==='Synthetic final reply'));assert.equal(await readFile(file,'utf8'),original);}finally{await server.stop();}
});
