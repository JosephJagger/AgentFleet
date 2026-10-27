import {grokQuestions,grokQuestionAnswer} from '../src/grok-questions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {grokResult,parseGrokOperation,sanitizeGrokResult} from '../src/grok-operations.js';
import {grokForm,grokFormAnswer} from '../src/grok-elicitation.js';
import {parseGrokSettings,parseGrokModels,grokSettingsActive} from '../src/acp-updates.js';
test('native operations cannot override session, cwd, method or confirmation',()=>{
 for(const body of [
  {operation:'fs.write_file',arguments:{}},
  {operation:'tasks.list',arguments:{sessionId:'other'}},
  {operation:'session.fork',arguments:{newCwd:'/other'}},
  {operation:'task.stop',arguments:{taskId:'t'}},
  {operation:'task.stop',arguments:{taskId:'t'},confirmed:'true'},
  {operation:'rewind.execute',arguments:{targetPromptIndex:-1,mode:'all'},confirmed:true},
  {operation:'rewind.execute',arguments:{targetPromptIndex:1,mode:'force'},confirmed:true},
 ])assert.throws(()=>parseGrokOperation(body));
 assert.equal(parseGrokOperation({operation:'task.stop',arguments:{taskId:'t'},confirmed:true}).operation,'task.stop');
});
test('native result rendering keeps failure dispositions and excludes environment envelopes',()=>{
 const result=grokResult('plugins.list',{result:{plugins:[{name:'a',enabled:true,env:{TOKEN:'do-not-copy'},credentials:'hidden'}]}});
 assert.equal(result.rows.length,1);assert.equal(JSON.stringify(result).includes('do-not-copy'),false);assert.equal(JSON.stringify(result).includes('hidden'),false);
 assert.equal(grokResult('memory.forget',{outcome:'rejected',message:'changed'}).status,'rejected');
 assert.equal(grokResult('memory.flush',{disposition:'timed_out'}).status,'timed_out');
 assert.equal(grokResult('rewind.execute',{success:false,conflicts:[{path:'a',conflict_type:'content_mismatch'}]}).status,'failed');
 assert.equal(grokResult('history.list',{prompts:['actual prompt']}).rows[0]?.detail,'actual prompt');
});
test('context window uses the native model catalog and rejects ambiguous values',()=>{
 for(const n of [-1,0,1.5,Infinity,10000001,'256000'])assert.equal(parseGrokSettings({contextWindow:n}),undefined);
 assert.equal(parseGrokSettings({contextWindow:256000})?.contextWindow,256000);
 assert.deepEqual(parseGrokModels([{modelId:'grok',name:'Grok',_meta:{contextWindows:[256000,500000,-1,'256000']}}])[0]?.contextWindows,[256000,500000]);
});
test('MCP forms require explicit bounded answers and preserve primitive types',()=>{
 const form=grokForm({mode:'form',serverName:'test',message:'Choose',requestedSchema:{type:'object',properties:{choice:{type:'string',enum:['a','b']},count:{type:'integer',minimum:1,maximum:3},enabled:{type:'boolean'}},required:['choice','count','enabled']}});
 assert.deepEqual(grokFormAnswer(form,{choice:{answers:['a']},count:{answers:['2']},enabled:{answers:['false']}}),{choice:'a',count:2,enabled:false});
 assert.throws(()=>grokFormAnswer(form,{choice:{answers:['outside']},count:{answers:['2']},enabled:{answers:['false']}}));
 assert.throws(()=>grokFormAnswer(form,{choice:{answers:['a']},count:{answers:['4']},enabled:{answers:['yes']}}));
});
test('unsupported, secret and URL MCP requests never become automatic approvals',()=>{
 for(const p of [{mode:'url',url:'https://example.test'},...[{type:'string',isSecret:true},{type:'string',format:'password'},{type:'object'},{type:'string',pattern:'.*'},{type:'number',exclusiveMinimum:5},{type:'boolean',enum:['true']},{type:'string',minLength:-1}].map(v=>({mode:'form',requestedSchema:{type:'object',properties:{x:v},required:['x']}}))])assert.throws(()=>grokForm(p));
});
test('operation contracts and provider capabilities are identical across independent services',async()=>{
 for(const files of [['apps/local-agent/src/grok-operations.ts','apps/control-plane/src/grok-operations.ts','apps/web/src/lib/grok-operations.ts']]){
  const values=await Promise.all(files.map(p=>readFile(new URL('../../../../'+p,import.meta.url),'utf8')));assert.equal(new Set(values).size,1);
 }
});

test('the control plane bounds native operation rows independently of the host',()=>{
 const result=sanitizeGrokResult({operation:'tasks.list',status:'received',rows:Array.from({length:200},()=>({name:'n'.repeat(500),status:'s'.repeat(80),detail:'d'.repeat(20000)}))})!;
 assert.ok(result.rows.length<=100);assert.ok(result.rows.reduce((n,r)=>n+r.name.length+r.status.length+r.detail.length,0)<=24000);
});

test('X search inheritance differs from explicit clearing and validates calendar dates',()=>{
 assert.equal(parseGrokSettings({})?.xSearch,undefined);
 assert.deepEqual(parseGrokSettings({xSearch:null}),{xSearch:null});assert.equal(grokSettingsActive({xSearch:null}),true);
 assert.equal(parseGrokSettings({xSearch:{fromDate:'2026-02-31'}}),undefined);
 assert.deepEqual(parseGrokSettings({xSearch:{fromDate:'2026-10-01'}}),{xSearch:{fromDate:'2026-10-01'}});
});


test('MCP optional fields can be explicitly omitted without coercing false, zero or a missing required answer',()=>{
 const form=grokForm({mode:'form',requestedSchema:{type:'object',properties:{required:{type:'string'},count:{type:'number'},enabled:{type:'boolean'}},required:['required']}});
 const omit=form.questions.find(q=>q.id==='count')!.options[0]!.label;
 assert.deepEqual(grokFormAnswer(form,{required:{answers:['yes']},count:{answers:[omit]},enabled:{answers:['false']}}),{required:'yes',enabled:false});
 assert.deepEqual(grokFormAnswer(form,{required:{answers:['yes']},count:{answers:['0']},enabled:{answers:[omit]}}),{required:'yes',count:0});
 assert.throws(()=>grokFormAnswer(form,{count:{answers:[omit]},enabled:{answers:[omit]}}));
 for(const required of [['unknown'],['required','required'],[1]])assert.throws(()=>grokForm({mode:'form',requestedSchema:{type:'object',properties:{required:{type:'string'}},required}}));
});
test('literal file operations reject traversal, git pathspecs and invalid paging',()=>{
 for(const filePath of ['../secret','/etc/passwd','a/../b','a\\b','*.ts',':(glob)**','-A','a//b'])assert.throws(()=>parseGrokOperation({operation:'git.stage',arguments:{filePath},confirmed:true}));
 for(const offset of [-1,0.5,Infinity,'0'])assert.throws(()=>parseGrokOperation({operation:'files.list',arguments:{filePath:'.',offset}}));
 assert.equal(parseGrokOperation({operation:'git.stage',arguments:{filePath:'src/a b.ts'},confirmed:true}).arguments.filePath,'src/a b.ts');
});
test('catalog accepts parameterized model selectors without allowing arbitrary command strings',()=>{
 const id='grok-4.7[fast=true]';
 assert.equal(parseGrokSettings({model:id})?.model,id);
 assert.equal(parseGrokModels([{modelId:id,name:'Fast'}])[0]?.id,id);
 for(const model of ['grok --yolo','grok[x=$(cmd)]','grok[x=true][y=true]','grok[fast=true;]'])assert.equal(parseGrokSettings({model}),undefined);
 assert.equal(grokSettingsActive({mode:'default'}),true);
 assert.equal(grokSettingsActive({permissionMode:'default'}),true);
});

test('Grok interviews accept multi-select labels and one free-text note, and still reject preview or secret questions',()=>{
 const question={question:'Pick one',options:[{label:'A',description:'First'},{label:'B',description:'Second'}]};
 for(const questions of [[question,question],[{...question,isSecret:true}],[{...question,multiSelect:true,multi_select:false}],[{...question,options:[{label:'A'},{label:'A'}]}],[{...question,options:[{label:'A',preview:'<script>bad</script>'}]}],[{...question,question:'__proto__'}]])assert.throws(()=>grokQuestions({questions}));
 const questions=grokQuestions({questions:[question]});
 assert.equal(questions[0]?.multi,undefined);
 assert.equal(grokQuestions({questions:[{...question,multiSelect:null,multi_select:null}]})[0]?.multi,undefined);
 assert.equal(grokQuestions({questions:[{...question,multi_select:null}]})[0]?.multi,undefined);
 assert.equal(grokQuestions({questions:[{...question,multiSelect:null,multi_select:true}]})[0]?.multi,true);
 assert.throws(()=>grokQuestions({questions:[{...question,multiSelect:null,multi_select:'yes'}]}));
 assert.throws(()=>grokQuestionAnswer(questions,{wrong:{answers:['A']}}));
 assert.deepEqual(grokQuestionAnswer(questions,{grok_question_0:{answers:['A']}}),{outcome:'accepted',answers:{'Pick one':['A']}});
 const multi=grokQuestions({questions:[{...question,question:'Pick any',multi_select:true},{question:'Also',multiSelect:true,options:[{label:'C'}]}]});
 assert.equal(multi[0]?.multi,true);
 assert.deepEqual(grokQuestionAnswer(multi,{grok_question_0:{answers:['A','B']},grok_question_1:{answers:['C','plain note']}}),{outcome:'accepted',answers:{'Pick any':['A','B'],Also:['C','Other']},annotations:{Also:{notes:'plain note'}}});
 assert.deepEqual(grokQuestionAnswer(multi,{grok_question_0:{answers:['typed only']},grok_question_1:{answers:['C']}}),{outcome:'accepted',answers:{'Pick any':['Other'],Also:['C']},annotations:{'Pick any':{notes:'typed only'}}});
 assert.throws(()=>grokQuestionAnswer(multi,{grok_question_0:{answers:['A','one','two']},grok_question_1:{answers:['C']}}));
});
