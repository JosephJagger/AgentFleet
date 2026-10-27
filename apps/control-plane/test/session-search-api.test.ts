import test from 'node:test';
import assert from 'node:assert/strict';
import { buildControlPlane } from './server-fixture.js';
import { loadConfig } from '../src/config.js';
import { AuthService } from '../src/auth.js';
import { SessionSearchService } from '../src/session-search.js';

test('global search requires authentication, is not cached, and rechecks a revoked login after async reads',async t=>{
  const config={...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'search-api@example.test',ADMIN_PASSWORD:'fixture-password',PUBLIC_ORIGIN:'http://fixture.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:'};
  const {app,db}=await buildControlPlane(config);t.after(()=>app.close());
  assert.equal((await app.inject({method:'GET',url:'/api/session-search?q=test'})).statusCode,401);
  const auth=new AuthService(db,config),login=auth.login(config.adminEmail,config.adminPassword,'127.0.0.1','fixture');
  const headers={cookie:`${config.cookieName}=${login.sessionToken}`};
  const read=()=>app.inject({method:'GET',url:'/api/session-search?q=test',headers});
  const result=await read();assert.equal(result.statusCode,200,result.body);assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.json().total,0);
  assert.equal((await app.inject({method:'GET',url:'/api/session-search?q=test&limit=1000',headers})).statusCode,400);
  const original=SessionSearchService.prototype.search;
  t.mock.method(SessionSearchService.prototype,'search',async function(this:SessionSearchService,...args:Parameters<typeof original>){
    const result=await original.apply(this,args);
    db.run('UPDATE client_sessions SET revoked_at=? WHERE client_session_id=?',new Date().toISOString(),login.principal.clientSessionId);
    return result;
  });
  assert.equal((await read()).statusCode,401);
  assert.equal(db.get<{n:number}>('SELECT count(*) AS n FROM commands')!.n,0);
});
