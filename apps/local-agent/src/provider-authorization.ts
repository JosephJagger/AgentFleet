import {execFile} from 'node:child_process';
import {isSea} from 'node:sea';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {AcpConnection} from './acp-connection.js';
import type {AcpExecutable} from './acp-providers.js';
import type {ManagedEligibility} from './managed-provider.js';
import {AgentError} from './errors.js';
const exec=promisify(execFile);
export type AuthorizationState='ready'|'login_required'|'unverified';
export function claudeAuthorization(value:unknown):AuthorizationState {
  if(!value||typeof value!=='object')return 'unverified';
  const v=value as {loggedIn?:unknown;authMethod?:unknown};
  if(v.loggedIn===false||v.authMethod==='none')return 'login_required';
  return v.loggedIn===true&&['claude.ai','oauth_token','api_key','api_key_helper','third_party'].includes(String(v.authMethod))?'ready':'unverified';
}
export function grokAuthorization(value:unknown):AuthorizationState {
  if(!value||typeof value!=='object')return 'unverified';
  const v=value as {authenticated?:unknown;meta?:{gate?:unknown}};
  if(v.authenticated===false)return 'login_required';
  return v.authenticated===true&&!v.meta?.gate?'ready':'unverified';
}
/** Native status only. No prompt, credential-file reads, browser login or credential exports. */
export async function authorizeClaude(binary:string,signal?:AbortSignal):Promise<AuthorizationState> {
  try {
    const script=/\.[cm]?js$/i.test(binary);
    if(script&&isSea())return 'unverified';
    const {stdout}=await exec(script?process.execPath:binary,[...(script?[binary]:[]),'auth','status','--json'],{cwd:homedir(),timeout:15000,maxBuffer:65536,windowsHide:true,env:{...process.env,DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},...(signal?{signal}:{})});
    return claudeAuthorization(JSON.parse(stdout));
  } catch(error) {
    // CLI uses exit 1 for a structured logged-out response. Never propagate raw account data/stderr.
    const e=error as {code?:unknown;stdout?:unknown};
    if(e.code===1&&typeof e.stdout==='string')try {return claudeAuthorization(JSON.parse(e.stdout))==='login_required'?'login_required':'unverified';}catch{}
    return 'unverified';
  }
}
export async function authorizeGrok(executable:AcpExecutable,signal?:AbortSignal):Promise<AuthorizationState> {
  const cwd=await mkdtemp(join(tmpdir(),'agentfleet-auth-check-'));
  const connection=new AcpConnection({executable:executable.executable,args:[...executable.prefix,'--no-auto-update','agent','--no-leader','stdio'],cwd,notification:()=>{},request:async()=>{throw new Error('Status check does not authorize requests');},exit:()=>{}});
  const abort=()=>connection.close();signal?.addEventListener('abort',abort,{once:true});
  try {
    signal?.throwIfAborted();connection.start();
    const init=await connection.call('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'agentfleets-auth-check',version:'1.0.0'}},15000) as {protocolVersion?:unknown};
    if(init?.protocolVersion!==1)return 'unverified';
    return grokAuthorization(await connection.call('_x.ai/auth/check_subscription',{},15000));
  } catch(error) {return error instanceof AgentError&&error.code==='ACP_REMOTE_ERROR'&&error.message.includes('(-32000)')?'login_required':'unverified';}
  finally {signal?.removeEventListener('abort',abort);await connection.closeAndWait().catch(()=>undefined);await rm(cwd,{recursive:true,force:true});}
}
export function requireManagedEligibility(value:ManagedEligibility) {
  if(value.state==='not_installed')throw new AgentError('PROVIDER_NOT_INSTALLED','请先在主机安装并完成登录授权');
  if(value.state==='login_required')throw new AgentError('PROVIDER_LOGIN_REQUIRED','请先在主机完成登录授权');
  if(value.state!=='ready'&&value.state!=='managed')throw new AgentError('PROVIDER_AUTH_UNVERIFIED','暂时无法核验授权，请在主机检查登录状态后重试');
}
