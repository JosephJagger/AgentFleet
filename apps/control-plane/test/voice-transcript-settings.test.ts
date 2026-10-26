import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.js';
import {buildControlPlane} from './server-fixture.js';
test('transcript settings require login/CSRF, reject stale saves and retire confirmation endpoints',async t=>{
 const origin='http://example.test';const {app}=await buildControlPlane({...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'owner@example.test',ADMIN_PASSWORD:'correct horse battery staple',PUBLIC_ORIGIN:origin,COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:'});t.after(()=>app.close());
 const url='/api/voice-transcript-settings';assert.equal((await app.inject({url})).statusCode,401);
 const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{email:'owner@example.test',password:'correct horse battery staple'}});
 const cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; ');const headers={cookie,origin,'x-csrf-token':login.json().csrfToken};
 assert.deepEqual((await app.inject({url,headers})).json(),{enabled:false,revision:0,retentionDays:30});
 assert.equal((await app.inject({method:'PUT',url,headers:{cookie,origin},payload:{enabled:true,revision:0}})).statusCode,403);
 assert.equal((await app.inject({method:'PUT',url,headers,payload:{enabled:true,revision:0}})).statusCode,200);
 assert.equal((await app.inject({method:'PUT',url,headers,payload:{enabled:false,revision:0}})).statusCode,409);
 assert.equal((await app.inject({method:'PUT',url,headers,payload:{enabled:'yes',revision:1}})).statusCode,400);
 assert.equal((await app.inject({url:'/api/voice-transcript-tails',headers})).statusCode,404);
 assert.equal((await app.inject({method:'PATCH',url:'/api/voice-transcript-tails/old',headers,payload:{confirmed:true,action:'save'}})).statusCode,404);
});
