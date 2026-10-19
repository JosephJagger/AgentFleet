import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {homedir,platform} from 'node:os';
import {join} from 'node:path';
import {isRecord} from './util.js';

const AUTH_KEY='https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
export async function grokCredentialStamp():Promise<string|undefined>{try{return createHash('sha256').update(await readFile(join(process.env.GROK_HOME||join(homedir(),'.grok'),'auth.json'))).digest('hex');}catch{return undefined;}}
export function cursorAuthPath(home:string,env:NodeJS.ProcessEnv,os=platform()):string{
  if(os==='win32')return join(env.APPDATA||join(home,'AppData','Roaming'),'Cursor','auth.json');
  if(os==='darwin')return join(home,'.cursor','auth.json');
  return join(env.XDG_CONFIG_HOME||join(home,'.config'),'cursor','auth.json');
}
export interface SharedSubscription {source:'grok-native';verifiedAt:string;expiresAt:string;}
/** Both authenticated services must confirm the same individual billing identity.
 * IDs/tokens never leave this host. No email matching or JWT-only identity claims. */
export async function verifySharedSubscription(options:{read?:typeof readFile;fetch?:typeof fetch;env?:NodeJS.ProcessEnv;home?:string;expectedGrokStamp?:string}={}):Promise<SharedSubscription|undefined>{
  const env=options.env??process.env,home=options.home??homedir(),read=options.read??readFile,request=options.fetch??fetch;
  // Custom credentials/endpoints can select another principal than the native files.
  if(['XAI_API_KEY','GROK_API_KEY','GROK_AUTH','GROK_CODE_XAI_API_KEY','CURSOR_API_KEY','CURSOR_AUTH_TOKEN','CURSOR_API_BASE_URL','CURSOR_WEBSITE_URL'].some(k=>env[k]))return;
  const paths=[join(env.GROK_HOME||join(home,'.grok'),'auth.json'),cursorAuthPath(home,env)];
  try{
    const before=await Promise.all(paths.map(p=>read(p,'utf8')));
    if(options.expectedGrokStamp&&createHash('sha256').update(String(before[0])).digest('hex')!==options.expectedGrokStamp)return;
    const grok=JSON.parse(String(before[0]))[AUTH_KEY],cursor=JSON.parse(String(before[1]));
    if(!isRecord(grok)||typeof grok.key!=='string'||!grok.key||grok.auth_mode!=='oidc'||grok.principal_type!=='User'||cursor.apiKey||typeof cursor.accessToken!=='string'||!cursor.accessToken)return;
    const signal=AbortSignal.timeout(5000);
    const [g,c]=await Promise.all([
      request('https://auth.x.ai/oauth2/userinfo',{headers:{Authorization:`Bearer ${grok.key}`},signal,redirect:'error'}),
      request('https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandMarketingIdentity',{method:'POST',headers:{Authorization:`Bearer ${cursor.accessToken}`,'Content-Type':'application/json','Connect-Protocol-Version':'1'},body:'{}',signal,redirect:'error'})
    ]);
    if(!g.ok||!c.ok)return;
    const [gi,ci]:unknown[]=await Promise.all([g.json(),c.json()]);
    if(!isRecord(gi)||!isRecord(ci)||ci.workspace!=='SAND_MARKETING_WORKSPACE_UNIFIED'||typeof gi.sub!=='string'||!gi.sub||ci.externalId!==gi.sub||grok.principal_id!==gi.sub)return;
    const after=await Promise.all(paths.map(p=>read(p,'utf8')));
    if(after.some((v,i)=>String(v)!==String(before[i])))return;
    const now=Date.now();return {source:'grok-native',verifiedAt:new Date(now).toISOString(),expiresAt:new Date(now+180000).toISOString()};
  }catch{return undefined;}
}
