import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTikHub, parseAnalysis, ResetRadar } from "../src/reset-radar.js";

const initial = Date.parse("2026-09-29T08:00:00Z"), hour=3600000;
const post={id:"123",text:"We will reset Codex usage limits",created_at:new Date(initial-hour).toISOString(),context:""};
const payload={code:200,data:{timeline:[{tweet_id:post.id,text:post.text,created_at:post.created_at,author:{screen_name:"thsottiaux"}}]}};
test("trusted source and evidence; unknown reset time remains unknown",()=>{
 assert.equal(parseTikHub(payload).posts.length,1);
 assert.equal(parseTikHub({code:200,data:{timeline:[{...payload.data.timeline[0],author:{screen_name:"other"}}]}}).posts.length,0);
 const result={results:[{id:"123",signal:"announced",evidence:post.text,expectedAt:null}]};
 assert.equal(parseAnalysis(result,[post],initial).get("123")?.expectedAt,null);
 assert.throws(()=>parseAnalysis({results:[{...result.results[0],evidence:"invented evidence"}]},[post],initial));
});
test("persistent dedup, hourly collection, 7-day retention and newest-first timeline",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"radar-")); let now=initial, sourceCalls=0, analysisCalls=0;
 const fetcher=(async (url: string|URL|Request)=>{
  if(String(url).includes("tikhub")){sourceCalls++;return Response.json(payload);}
  analysisCalls++;return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({results:[{id:"123",signal:"none",summary:"介绍 Codex 最新动态"}]})}}]});
 }) as typeof fetch;
 const options={token:"test",aiKey:"test",fetcher,now:()=>now,statePath:join(dir,"state.json")};
 try{
 const radar=new ResetRadar(options); await Promise.all([radar.refresh(),radar.refresh()]);
 assert.equal(sourceCalls,1);assert.equal(analysisCalls,1); assert.equal(radar.status().timeline.length,1);
 now+=hour;await radar.refresh();assert.equal(sourceCalls,2);assert.equal(analysisCalls,1);
 const restarted=new ResetRadar(options);await restarted.refresh();assert.equal(sourceCalls,2);
 now+=24*hour;await restarted.refresh();assert.equal(restarted.status().timeline.length,1);assert.equal(analysisCalls,1);
 now=Date.parse(post.created_at)+7*24*hour;await restarted.refresh();assert.equal(restarted.status().timeline.length,0);assert.equal(analysisCalls,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("signal never pauses hourly collection; quota is read-only",async()=>{
 let now=initial,calls=0;
 const fetcher=(async(url:string|URL|Request)=>{
 calls++;return String(url).includes("tikhub")?Response.json(payload):Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({results:[{id:"123",signal:"announced",evidence:post.text,expectedAt:null,summary:"宣布将重置 Codex 用量，时间未定"}]})}}]});
 }) as typeof fetch;
 const radar=new ResetRadar({token:"test",aiKey:"test",fetcher,now:()=>now});
 await radar.refresh();const account={remainingPercent:10,resetCardsAvailable:0};
 assert.ok(await radar.read("a",account)); assert.equal(account.remainingPercent,10);
 now+=2*hour;await radar.refresh();assert.equal(calls,3);
 assert.equal(await radar.read("a",{...account,remainingPercent:100}),null);
 await radar.refresh();assert.equal(calls,3);
 now=Date.parse("2026-09-29T16:01:00Z");await radar.refresh();assert.equal(calls,4);
 assert.equal(radar.status().timeline.length,1);
});
test("source errors are visible, missing config makes no requests",async()=>{
 const radar=new ResetRadar({token:"test",aiKey:"test",now:()=>initial,fetcher:(async()=>{throw Error("secret");}) as typeof fetch});
 await radar.refresh();assert.equal(radar.status().state,"error");assert.ok(!radar.status().message?.includes("secret"));
 const empty=new ResetRadar({token:"",aiKey:""});await empty.refresh();assert.equal(empty.status().state,"unconfigured");
});

test("historical signals survive midnight and restart but never extend prediction or pause collection",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"radar-history-"));let now=initial,calls=0;
 const fetcher=(async(url:string|URL|Request)=>{calls++;return String(url).includes("tikhub")?Response.json(payload):Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({results:[{id:"123",signal:"announced",evidence:post.text,summary:"宣布重置用量"}]})}}]});}) as typeof fetch;
 const options={token:"test",aiKey:"test",fetcher,now:()=>now,statePath:join(dir,"state.json")};
 try {
  const radar=new ResetRadar(options);await radar.refresh();
  now=Date.parse("2026-09-29T16:00:00Z");assert.equal(radar.status().timeline.length,1);
  now=initial+24*hour;const restarted=new ResetRadar(options);await restarted.refresh();
  assert.equal(restarted.status().timeline.length,1);assert.equal(await restarted.read("new-account",{remainingPercent:20,resetCardsAvailable:0}),null);
  const n=calls;now+=hour;await restarted.refresh();assert.equal(calls,n+1,"expired historical signal does not pause the hourly poll or reanalyze");
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("expired signal releases a same-day pause and collects new posts",async()=>{
 let now=Date.parse("2026-09-29T16:01:00Z"),sourceCalls=0;
 const old={...post,created_at:new Date(now-23*hour).toISOString()};
 const recent={...post,id:"456",text:"New features",created_at:new Date(now+2*hour).toISOString()};
 const fetcher=(async(url:string|URL|Request)=>{
  if(String(url).includes("tikhub")){sourceCalls++;const p=sourceCalls===1?old:recent;return Response.json({code:200,data:{timeline:[{...p,tweet_id:p.id,author:{screen_name:"thsottiaux"}}]}});}
  const result=sourceCalls===1?{id:old.id,signal:"announced",evidence:old.text,summary:"宣布重置"}:{id:recent.id,signal:"none",summary:"介绍新功能"};
  return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({results:[result]})}}]});
 }) as typeof fetch;
 const radar=new ResetRadar({token:"test",aiKey:"test",fetcher,now:()=>now});await radar.refresh();
 now+=2*hour;await radar.refresh();assert.equal(sourceCalls,2);assert.equal(radar.status().timeline.length,2);
 assert.equal(await radar.read("account",{remainingPercent:20,resetCardsAvailable:0}),null);
});

test("persisted pause without its signal cannot block collection",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"radar-stale-pause-"));
 try {
  const {writeFileSync}=await import("node:fs");const path=join(dir,"state.json");
  writeFileSync(path,JSON.stringify({version:1,lastAttempt:initial-2*hour,checkedAt:initial-2*hour,pauseDay:Math.floor((initial+8*hour)/(24*hour)),callDay:0,calls:0,error:null,posts:[],seen:[],accounts:{}}));
  let calls=0;const radar=new ResetRadar({token:"test",aiKey:"test",statePath:path,now:()=>initial,fetcher:(async()=>{calls++;return Response.json({code:200,data:{timeline:[]}});}) as typeof fetch});
  await radar.refresh();assert.equal(calls,1);assert.equal(radar.status().checkedAt,new Date(initial).toISOString());
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test("conditional plans require a quoted condition and never invent a reset deadline",()=>{
 const text="Over the next 28 days, each day we'll either ship an improvement or ship a full reset";
 const p={...post,text};const row={id:p.id,signal:"conditional",evidence:text,condition:"当天未发布改进时才重置额度",conditionEvidence:"either ship an improvement or ship a full reset",expectedAt:new Date(initial+hour).toISOString(),timeEvidence:"28 days"};
 const prediction=parseAnalysis({results:[row]},[p],initial).get(p.id)!;
 assert.equal(prediction.signal,"conditional");assert.equal(prediction.condition,row.condition);assert.equal(prediction.expectedAt,null);
 assert.throws(()=>parseAnalysis({results:[{...row,conditionEvidence:"made up"}]},[p],initial));
 assert.equal(parseAnalysis({results:[{id:p.id,signal:"none"}]},[p],initial).get(p.id),null);
});

test("card grants and quota restoration suppress only their matching announcement",async()=>{
 for(const signal of ["announced","card-announced","conditional","card-conditional"]){
  const fetcher=(async(url:string|URL|Request)=>String(url).includes("tikhub")?Response.json(payload):Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({results:[{id:post.id,signal,evidence:post.text,condition:"满足公告条件时",conditionEvidence:"reset",summary:"重置消息"}]})}}]})) as typeof fetch;
  const radar=new ResetRadar({token:"t",aiKey:"t",now:()=>initial,fetcher});await radar.refresh();
  const base={remainingPercent:10,resetCardsAvailable:0};await radar.read("quota",base);await radar.read("card",base);
  const quota=await radar.read("quota",{...base,remainingPercent:100});const card=await radar.read("card",{...base,resetCardsAvailable:1});
  assert.equal(quota===null,signal==="announced");assert.equal(card===null,signal==="card-announced");
 }
});

test("one-time history backfill restores missing analyzed IDs then resumes hourly dedup",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"radar-backfill-"));let now=initial,source=0,analysis=0;
 try {
  const {writeFileSync}=await import("node:fs");const path=join(dir,"state.json");
  writeFileSync(path,JSON.stringify({version:1,lastAttempt:0,checkedAt:0,pauseDay:null,callDay:0,calls:0,error:null,posts:[],seen:[post.id],accounts:{}}));
  const old={...payload,data:{timeline:[{...payload.data.timeline[0],created_at:new Date(initial-3*24*hour).toISOString()}]}};
  const fetcher=(async(url:string|URL|Request)=>{if(String(url).includes("tikhub")){source++;return Response.json(old);}analysis++;return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({results:[{id:post.id,signal:"none",summary:"历史消息"}]})}}]});}) as typeof fetch;
  const options={token:"t",aiKey:"t",statePath:path,fetcher,now:()=>now};const radar=new ResetRadar(options);await radar.refresh();assert.equal(radar.status().timeline.length,1);assert.equal(analysis,1);
  now+=hour;const restarted=new ResetRadar(options);await restarted.refresh();assert.equal(source,2);assert.equal(analysis,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
