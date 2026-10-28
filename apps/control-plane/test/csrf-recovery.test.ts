import test from 'node:test';
import assert from 'node:assert/strict';
import {buildControlPlane} from './server-fixture.js';
import {loadConfig} from '../src/config.js';
import {AuthService} from '../src/auth.js';

const origin='http://csrf.test';
test('existing cookie sessions recover stable CSRF tokens without rotating legacy tokens or granting unauthenticated writes',async t=>{
 const config={...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'csrf@example.test',ADMIN_PASSWORD:'fixture-password',PUBLIC_ORIGIN:origin,COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:'};
 const {app,db}=await buildControlPlane(config);t.after(()=>app.close());
 const auth=new AuthService(db,config),first=auth.login(config.adminEmail,config.adminPassword,'127.0.0.1','fixture'),second=auth.login(config.adminEmail,config.adminPassword,'127.0.0.1','second browser');
 const cookie=`${config.cookieName}=${first.sessionToken}`,otherCookie=`${config.cookieName}=${second.sessionToken}`;
 let writes=0;
 app.post('/api/test-csrf',async request=>{const principal=auth.authenticateRequest(request);auth.requireCsrf(request,principal);writes++;return {ok:true};});
 const write=(token?:string,cookieValue=cookie,originValue=origin)=>app.inject({method:'POST',url:'/api/test-csrf',headers:{cookie:cookieValue,origin:originValue,...(token?{'x-csrf-token':token}:{})}});
 assert.equal((await write()).json().error.code,'CSRF_INVALID');assert.equal((await write('stale')).statusCode,403);assert.equal(writes,0);
 const status=await app.inject({method:'GET',url:'/api/auth/status',headers:{cookie}});
 assert.equal(status.statusCode,200);assert.equal(status.headers['cache-control'],'no-store');
 const recovered=status.json().csrfToken;
 assert.equal(typeof recovered,'string');assert.notEqual(recovered,first.sessionToken);assert.notEqual(recovered,first.csrfToken);
 assert.equal((await app.inject({method:'GET',url:'/api/auth/status',headers:{cookie}})).json().csrfToken,recovered);
 assert.equal(db.get<{csrf_hash:string}>('SELECT csrf_hash FROM client_sessions WHERE client_session_id=?',first.principal.clientSessionId)!.csrf_hash,first.principal.csrfHash);
 // Reconstructing the service (as after deployment) keeps both credentials valid.
 const restarted=new AuthService(db,config);
 const request={cookies:{[config.cookieName]:first.sessionToken},headers:{origin,'x-csrf-token':recovered}} as unknown as Parameters<AuthService['requireCsrf']>[0];
 restarted.requireCsrf(request,restarted.authenticateRequest(request));
 assert.equal((await write(recovered)).statusCode,200);assert.equal((await write(first.csrfToken)).statusCode,200);assert.equal(writes,2);
 assert.equal((await write(recovered,otherCookie)).statusCode,403);
 assert.equal((await write(recovered,cookie,'https://attacker.test')).statusCode,403);assert.equal(writes,2);
 for(const headers of [{cookie,origin:'https://attacker.test'},{cookie,'sec-fetch-site':'cross-site'}])assert.equal((await app.inject({method:'GET',url:'/api/auth/status',headers})).statusCode,403);
 const anonymous=await app.inject({method:'GET',url:'/api/auth/status'});assert.deepEqual(anonymous.json(),{authenticated:false});assert.equal(anonymous.headers['cache-control'],'no-store');
 assert.equal((await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie,origin,'x-csrf-token':recovered}})).statusCode,200);
 assert.deepEqual((await app.inject({method:'GET',url:'/api/auth/status',headers:{cookie}})).json(),{authenticated:false});
 assert.equal((await write(recovered)).statusCode,401);assert.equal(writes,2);
});
