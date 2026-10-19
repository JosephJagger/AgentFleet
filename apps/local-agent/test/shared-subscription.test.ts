import test from 'node:test';
import assert from 'node:assert/strict';
import {verifySharedSubscription} from '../src/shared-subscription.js';
const key='https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const auth=JSON.stringify({[key]:{key:'secret-grok',auth_mode:'oidc',principal_type:'User',principal_id:'same'}});
const cursor=JSON.stringify({accessToken:'secret-cursor'});
function fixture(subject='same',workspace='SAND_MARKETING_WORKSPACE_UNIFIED'){
 let reads=0;
 return {env:{},home:'/isolated',read:(async(path:unknown)=>{reads++;return String(path).includes('.grok')?auth:cursor;}) as never,fetch:(async(url:unknown,options:RequestInit)=>{assert.equal(options.redirect,'error');return new Response(JSON.stringify(String(url).includes('auth.x.ai')?{sub:subject}:{externalId:'same',workspace}),{status:200});}) as typeof fetch};
}
test('matches identities from both authenticated services without exposing them',async()=>{
 const result=await verifySharedSubscription(fixture());assert.equal(result?.source,'grok-native');assert.equal(Date.parse(result!.expiresAt)-Date.parse(result!.verifiedAt),180000);assert.ok(!JSON.stringify(result).includes('same'));assert.ok(!JSON.stringify(result).includes('secret'));
});
test('different accounts, legacy plans and custom API auth never share quota',async()=>{
 assert.equal(await verifySharedSubscription(fixture('different')),undefined);
 assert.equal(await verifySharedSubscription(fixture('same','SAND_MARKETING_WORKSPACE_LEGACY')),undefined);
 assert.equal(await verifySharedSubscription({...fixture(),env:{XAI_API_KEY:'other'}}),undefined);
 assert.equal(await verifySharedSubscription({...fixture(),expectedGrokStamp:'different'}),undefined);
});
test('network failures, logout and credential changes discard association',async()=>{
 assert.equal(await verifySharedSubscription({...fixture(),fetch:async()=>{throw Error('offline');}}),undefined);
 let count=0;assert.equal(await verifySharedSubscription({...fixture(),read:(async(path:unknown)=>{count++;return count>2?'{}':String(path).includes('.grok')?auth:cursor;}) as never}),undefined);
 assert.equal(await verifySharedSubscription({...fixture(),read:(async()=> '{}') as never}),undefined);
});
test('native auth storage path is separate from Cursor session configuration',async()=>{
 const {cursorAuthPath}=await import('../src/shared-subscription.js');
 const {join}=await import('node:path');
 assert.equal(cursorAuthPath('/home/test',{CURSOR_CONFIG_DIR:'/other'},'linux'),join('/home/test','.config','cursor','auth.json'));
 assert.equal(cursorAuthPath('/home/test',{},'darwin'),join('/home/test','.cursor','auth.json'));
 assert.equal(cursorAuthPath('/home/test',{APPDATA:'/roaming'},'win32'),join('/roaming','Cursor','auth.json'));
});
