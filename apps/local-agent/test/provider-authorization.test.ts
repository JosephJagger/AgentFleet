import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeAuthorization,grokAuthorization} from '../src/provider-authorization.js';
import {parseManagedEligibility} from '../src/managed-provider.js';
test('authorization requires a typed native status, never a token field or protocol handshake',()=>{
 for(const value of [null,{}, {token:'secret'}, {protocolVersion:1}, {loggedIn:'true'}, {loggedIn:true,authMethod:'unknown'}])assert.equal(claudeAuthorization(value),'unverified');
 for(const authMethod of ['claude.ai','oauth_token','api_key','api_key_helper','third_party'])assert.equal(claudeAuthorization({loggedIn:true,authMethod}),'ready');
 assert.equal(claudeAuthorization({loggedIn:false}),'login_required');assert.equal(claudeAuthorization({loggedIn:true,authMethod:'none'}),'login_required');
 for(const value of [null,{}, {bearerToken:'secret'}, {protocolVersion:1}, {authenticated:'true'}, {authenticated:true,meta:{gate:'subscription_required'}}])assert.equal(grokAuthorization(value),'unverified');
 assert.equal(grokAuthorization({authenticated:true,meta:{}}),'ready');assert.equal(grokAuthorization({authenticated:false}),'login_required');
});
test('public eligibility retains only state and bounded timestamp, never account information',()=>{
 const checkedAt=new Date().toISOString();assert.deepEqual(parseManagedEligibility({state:'ready',checkedAt,email:'private',token:'secret'}),{state:'ready',checkedAt});
 for(const value of [{state:'ready',checkedAt:'invalid'},{state:'ready',checkedAt:new Date(Date.now()+120000).toISOString()},{state:'authenticated',checkedAt},null])assert.equal(parseManagedEligibility(value),undefined);
});

test('native Claude status honors structured exit-1 logout and suppresses raw account output', {skip:process.platform==='win32'},async()=>{
 const {authorizeClaude}=await import('../src/provider-authorization.js');const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'auth-native-test-')),file=join(dir,'claude');
 try {
  await writeFile(file,'#!/bin/sh\n[ "$1 $2 $3" = "auth status --json" ] || exit 2\nprintf \'{"loggedIn":true,"authMethod":"claude.ai","email":"private"}\'\n',{mode:0o755});assert.equal(await authorizeClaude(file),'ready');
  await writeFile(file,'#!/bin/sh\nprintf \'{"loggedIn":false,"email":"private"}\'\nexit 1\n');assert.equal(await authorizeClaude(file),'login_required');
  await writeFile(file,'#!/bin/sh\nprintf \'private invalid output\'\nexit 1\n');assert.equal(await authorizeClaude(file),'unverified');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('npm Claude CLI scripts run under Node without invoking a shell',async()=>{
 const {authorizeClaude}=await import('../src/provider-authorization.js');const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'auth-npm-test-')),file=join(dir,'cli.js');
 try {await writeFile(file,"if(process.argv.slice(2).join(' ')!=='auth status --json')process.exit(2);console.log(JSON.stringify({loggedIn:true,authMethod:'api_key'}));");assert.equal(await authorizeClaude(file),'ready');} finally {await rm(dir,{recursive:true,force:true});}
});
