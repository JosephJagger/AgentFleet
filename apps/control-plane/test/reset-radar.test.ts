import test from "node:test";
import assert from "node:assert/strict";
import { forecastFromPosts, ResetRadar } from "../src/reset-radar.js";

const now = Date.parse("2026-09-23T12:00:00Z");
test("only an explicit future Codex reset produces a forecast", () => {
  assert.equal(forecastFromPosts([],now),null);
  assert.equal(forecastFromPosts([{id:"1",text:"We will reset Codex for all users tomorrow",created_at:"2026-09-23T11:00:00Z"}],now)?.kind,"temporary-reset");
  assert.equal(forecastFromPosts([{id:"5",text:"Codex weekly quota resets tomorrow",created_at:"2026-09-23T11:00:00Z"}],now),null);
  assert.equal(forecastFromPosts([{id:"2",text:"Codex quota reset has been applied",created_at:"2026-09-23T11:00:00Z"}],now),null);
  assert.equal(forecastFromPosts([{id:"3",text:"Codex may get more credits",created_at:"2026-09-23T11:00:00Z"}],now),null);
  assert.equal(forecastFromPosts([{id:"4",text:"Codex will reset in 2 hours",created_at:"2026-09-15T11:00:00Z"}],now),null);
});

test("hourly collection pauses on forecast and resumes only after a quota increase or new card",async()=>{
  let requests=0;
  const fetcher=(async (input:string|URL)=>{
    requests++;
    return new Response(JSON.stringify(String(input).includes("username")?{data:{id:"123"}}:{data:[{id:"999",text:"We will reset Codex in 6 hours",created_at:"2026-09-23T11:00:00Z"}]}),{status:200});
  }) as typeof fetch;
  const radar=new ResetRadar("test-token",fetcher);
  const account={remainingPercent:10,resetCardsAvailable:0};
  assert.ok(await radar.read("one",account,now));
  assert.equal(requests,2);
  assert.ok(await radar.read("one",account,now+2*3_600_000));
  assert.equal(requests,2);
  assert.equal(await radar.read("one",{...account,resetCardsAvailable:1},now+2*3_600_000),null);
  assert.equal(requests,2);
  assert.equal(await radar.read("one",{...account,resetCardsAvailable:1},now+2*3_600_000+1),null);
  assert.equal(requests,2);
  assert.equal(await radar.read("one",{...account,resetCardsAvailable:1},now+3*3_600_000+1),null);
  assert.equal(requests,4);
  assert.ok(await radar.read("another",account,now));
  assert.equal(await radar.read("another",{...account,remainingPercent:30},now+1),null);
});

test("an unconfigured collector gives no forecast and checks at most hourly",async()=>{
  const radar=new ResetRadar("");
  assert.equal(await radar.read("one",{remainingPercent:50,resetCardsAvailable:null},now),null);
  assert.equal(await radar.read("one",{remainingPercent:50,resetCardsAvailable:null},now+60_000),null);
});

test("a forecast is rechecked on the next Beijing calendar day even without quota changes",async()=>{
  let requests=0;
  const fetcher=(async(input:string|URL)=>{
    requests++;
    return new Response(JSON.stringify(String(input).includes("username")?{data:{id:"123"}}:{data:[{id:"999",text:"We will reset Codex in 12 hours",created_at:"2026-09-23T11:00:00Z"}]}),{status:200});
  }) as typeof fetch;
  const radar=new ResetRadar("test-token",fetcher);
  const account={remainingPercent:10,resetCardsAvailable:0};
  assert.ok(await radar.read("one",account,now));
  assert.ok(await radar.read("one",account,now+2*3_600_000));
  assert.equal(requests,2);
  assert.ok(await radar.read("one",account,Date.parse("2026-09-23T16:01:00Z")));
  assert.equal(requests,4);
});
