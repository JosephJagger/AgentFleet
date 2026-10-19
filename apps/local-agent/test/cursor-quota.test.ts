import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {cursorAuthPath,cursorUsageQuota,readCursorQuota} from '../src/cursor-quota.js';
const now=Date.now(),start=now-86400000,end=now+6*86400000;
const usage={billingCycleStart:String(start),billingCycleEnd:String(end),planUsage:{totalPercentUsed:4.598,autoPercentUsed:4.598,apiPercentUsed:0,bonusTooltip:'secret-looking prose'}};
const plan={planInfo:{planName:'Super',includedUsagePeriod:'INCLUDED_USAGE_PERIOD_WEEKLY',includedUsageResetsAt:String(end)}};
test('quota uses the native cycle, keeps only percentage and plan name',()=>{
 const quota=cursorUsageQuota(usage,plan)!;
 assert.equal(quota.windows[0]?.usedPercent,4.598);assert.equal(quota.windows[0]?.windowMinutes,10080);assert.equal(quota.windows[0]?.resetsAt,Math.floor(end/1000));assert.equal(quota.planName,'Super');
 assert.equal(JSON.stringify(quota).includes('secret'),false);
 assert.equal(cursorUsageQuota(usage,undefined)?.planName,undefined);
});
test('unknown or malformed reports are never shown as zero quota',()=>{
 assert.equal(cursorUsageQuota({...usage,planUsage:{}},plan),undefined);
 assert.equal(cursorUsageQuota({...usage,planUsage:{totalPercentUsed:101}},plan),undefined);
 assert.equal(cursorUsageQuota({...usage,billingCycleEnd:String(now-1)},plan),undefined);
 assert.equal(cursorUsageQuota({...usage,billingCycleStart:String(now+1000)},plan),undefined);
 assert.equal(cursorUsageQuota(undefined,plan),undefined);
});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
function fixture(overrides:{token?:()=>string;fetch?:typeof fetch;env?:NodeJS.ProcessEnv}={}){
 const calls:string[]=[];
 return {calls,env:overrides.env??{},home:'/isolated',read:(async()=>JSON.stringify({accessToken:overrides.token?.()??'tok'})) as never,
  fetch:overrides.fetch??((async(url:unknown,options:RequestInit)=>{calls.push(String(url).split('/').pop()!);assert.equal((options.headers as Record<string,string>).Authorization,'Bearer tok');assert.equal(options.redirect,'error');return String(url).endsWith('GetPlanInfo')?json(plan):json(usage);}) as never)};
}
test('reads both Cursor account methods with the logged-in token and nothing else',async()=>{
 const f=fixture();const quota=await readCursorQuota(f);
 assert.deepEqual(f.calls.sort(),['GetCurrentPeriodUsage','GetPlanInfo']);assert.equal(quota?.planName,'Super');assert.equal(JSON.stringify(quota).includes('tok'),false);
});
test('custom credentials, logout and unauthorised tokens yield no quota',async()=>{
 for(const key of ['CURSOR_API_KEY','CURSOR_AUTH_TOKEN','CURSOR_API_ENDPOINT'])assert.equal(await readCursorQuota({...fixture({env:{[key]:'x'}})}),undefined);
 assert.equal(await readCursorQuota({...fixture(),read:(async()=>'{}') as never}),undefined);
 assert.equal(await readCursorQuota({...fixture(),read:(async()=>{throw Error('ENOENT');}) as never}),undefined);
 assert.equal(await readCursorQuota({...fixture(),read:(async()=>JSON.stringify({apiKey:'k',accessToken:'tok'})) as never}),undefined);
 assert.equal(await readCursorQuota({...fixture({fetch:(async()=>json({},401)) as never})}),undefined);
});
test('transient failures throw so the prior observation is kept, and a login switch discards the result',async()=>{
 await assert.rejects(readCursorQuota({...fixture({fetch:(async()=>{throw Error('offline');}) as never})}));
 await assert.rejects(readCursorQuota({...fixture({fetch:(async()=>json({},500)) as never})}));
 await assert.rejects(readCursorQuota({...fixture({fetch:(async()=>json({unexpected:true})) as never})}));
 let reads=0;const f=fixture();
 assert.equal(await readCursorQuota({...f,read:(async()=>JSON.stringify({accessToken:++reads===1?'tok':'other'})) as never}),undefined);
});
test('native auth storage path is separate from Cursor session configuration',()=>{
 assert.equal(cursorAuthPath('/home/test',{CURSOR_CONFIG_DIR:'/other'},'linux'),join('/home/test','.config','cursor','auth.json'));
 assert.equal(cursorAuthPath('/home/test',{},'darwin'),join('/home/test','.cursor','auth.json'));
 assert.equal(cursorAuthPath('/home/test',{APPDATA:'/roaming'},'win32'),join('/roaming','Cursor','auth.json'));
});
