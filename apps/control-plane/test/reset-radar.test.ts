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
test("persistent dedup, hourly collection, 24h retention and newest-first timeline",async()=>{
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
 now+=24*hour;await restarted.refresh();assert.equal(restarted.status().timeline.length,0);assert.equal(analysisCalls,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("signal pauses collection until Beijing next day; quota is read-only",async()=>{
 let now=initial,calls=0;
 const fetcher=(async(url:string|URL|Request)=>{
 calls++;return String(url).includes("tikhub")?Response.json(payload):Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({results:[{id:"123",signal:"announced",evidence:post.text,expectedAt:null,summary:"宣布将重置 Codex 用量，时间未定"}]})}}]});
 }) as typeof fetch;
 const radar=new ResetRadar({token:"test",aiKey:"test",fetcher,now:()=>now});
 await radar.refresh();const account={remainingPercent:10,resetCardsAvailable:0};
 assert.ok(await radar.read("a",account)); assert.equal(account.remainingPercent,10);
 now+=2*hour;await radar.refresh();assert.equal(calls,2);
 assert.equal(await radar.read("a",{...account,remainingPercent:100}),null);
 await radar.refresh();assert.equal(calls,2);
 now=Date.parse("2026-09-29T16:01:00Z");await radar.refresh();assert.equal(calls,3);
 assert.equal(radar.status().timeline.length,1);
});
test("source errors are visible, missing config makes no requests",async()=>{
 const radar=new ResetRadar({token:"test",aiKey:"test",now:()=>initial,fetcher:(async()=>{throw Error("secret");}) as typeof fetch});
 await radar.refresh();assert.equal(radar.status().state,"error");assert.ok(!radar.status().message?.includes("secret"));
 const empty=new ResetRadar({token:"",aiKey:""});await empty.refresh();assert.equal(empty.status().state,"unconfigured");
});
