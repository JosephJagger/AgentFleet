import {homedir} from 'node:os';
import {join,isAbsolute,resolve,relative} from 'node:path';
import {readdir,readFile,lstat,realpath,mkdir,symlink,writeFile,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {AgentError} from './errors.js';
import {isRecord} from './util.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MARKER='agentfleet-cursor-terminal.json';
export interface CursorTerminalSession {id:string;cwd:string;title:string;root:string;directory:string;database:string;updatedAt:number;}
/** Cursor stores chats under its config directory, not CURSOR_DATA_DIR (project metadata). */
export function cursorConfigRoots(env:NodeJS.ProcessEnv=process.env,home=homedir()) {
  if(env.CURSOR_CONFIG_DIR?.trim())return [resolve(env.CURSOR_CONFIG_DIR)];
  return [...new Set([...(env.XDG_CONFIG_HOME?.trim()?[join(resolve(env.XDG_CONFIG_HOME),'cursor')]:[]),join(home,'.cursor')])];
}
async function regularJson(file:string):Promise<unknown> {
  const st=await lstat(file);if(!st.isFile()||st.size>65536)throw Error('Invalid metadata');
  return JSON.parse(await readFile(file,'utf8'));
}
async function directories(path:string){try{return (await readdir(path,{withFileTypes:true})).filter(d=>d.isDirectory());}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}}
export async function listCursorTerminalSessions(roots=cursorConfigRoots()):Promise<CursorTerminalSession[]> {
  const rows=new Map<string,CursorTerminalSession>();let scanned=0;
  for(const root of roots)for(const bucket of await directories(join(root,'chats'))) {
    for(const entry of await directories(join(root,'chats',bucket.name))) {
      if(++scanned>20000)throw new AgentError('CURSOR_CATALOG_LIMIT','Cursor 会话目录过大，未截断目录');
      if(!UUID.test(entry.name))continue;
      const directory=join(root,'chats',bucket.name,entry.name),database=join(directory,'store.db');
      let row:CursorTerminalSession;
      try {
        const meta=await regularJson(join(directory,'meta.json')),st=await lstat(database);
        if(!isRecord(meta)||meta.schemaVersion!==1||meta.hasConversation!==true||meta.isSubagent===true||typeof meta.cwd!=='string'||!isAbsolute(meta.cwd)||!st.isFile())continue;
        const canonical=await realpath(database),base=await realpath(join(root,'chats')),rel=relative(base,canonical);
        if(rel.startsWith('..')||isAbsolute(rel))continue;
        row={id:entry.name,cwd:resolve(meta.cwd),title:typeof meta.title==='string'?meta.title.slice(0,200):'Cursor',root,directory,database:canonical,updatedAt:st.mtimeMs};
      }catch{continue; /* Empty, incomplete or malformed sidecars are not sessions. */}
      const old=rows.get(row.id);
      if(old&&old.database!==row.database)throw new AgentError('CURSOR_SESSION_AMBIGUOUS','不同 Cursor 配置目录存在相同会话 ID，请核实原生目录');
      rows.set(row.id,row);
    }
  }
  return [...rows.values()];
}
/** No DB copy, migration or SQL write. Cursor's native ACP uses the same SQLite blob store.
 * A directory alias lets it open that exact store, preserving native ID and all context.
 * Never link the CLI sidecar: ACP rewrites it using a different metadata schema.
 */
export async function prepareCursorTerminalSession(row:CursorTerminalSession,version:string):Promise<void> {
  if(version!=='2026.10.16-e3cb207')throw new AgentError('CURSOR_STORAGE_UNVERIFIED','此 Cursor 版本的终端接续存储尚未验证；未修改原会话');
  if(process.platform==='win32')throw new AgentError('CURSOR_STORAGE_UNVERIFIED','Windows Cursor 终端接续尚未验证；原生 ACP 会话仍可使用');
  const current=(await listCursorTerminalSessions([row.root])).find(r=>r.id===row.id);
  if(!current||current.database!==row.database||current.cwd!==row.cwd)throw new AgentError('CURSOR_SESSION_CHANGED','Cursor 会话目录已变化，请刷新后重新接管');
  // Validate the native identity and blob-store schema before publishing any alias.
  const db=new DatabaseSync(row.database,{readOnly:true});
  try {
    const record=db.prepare('SELECT value FROM meta WHERE key = ?').get('0');
    if(typeof record?.value!=='string'||record.value.length>1024*1024)throw Error('Invalid metadata');
    const meta=JSON.parse(Buffer.from(record.value,'hex').toString('utf8'));
    if(!isRecord(meta)||meta.agentId!==row.id||typeof meta.latestRootBlobId!=='string'||!db.prepare('SELECT 1 FROM blobs WHERE id = ?').get(meta.latestRootBlobId))throw Error('Invalid native identity');
  }catch{throw new AgentError('CURSOR_STORAGE_UNVERIFIED','Cursor 原生会话存储格式无法核验；未修改原会话');}finally{db.close();}
  const parent=join(row.root,'acp-sessions'),target=join(parent,row.id);
  await mkdir(parent,{recursive:true,mode:0o700});
  const existing=await lstat(target).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;});
  if(existing)try {
    const st=existing;
    if(!st.isDirectory())throw Error('Invalid alias');
    const marker=await regularJson(join(target,MARKER));
    if(!isRecord(marker)||marker.version!==1||marker.database!==row.database||await realpath(join(target,'store.db'))!==row.database||(await lstat(join(target,'store.db'))).isSymbolicLink()!==true)throw Error('Conflicting store');
    const meta=await regularJson(join(target,'meta.json'));
    if(!isRecord(meta)||meta.cwd!==row.cwd)throw Error('Conflicting workspace');
    return;
  }catch{throw new AgentError('CURSOR_SESSION_CONFLICT','已有不同的 Cursor ACP 会话，未覆盖任何原生记录');}
  const staging=join(parent,`.agentfleet-${randomUUID()}`);
  await mkdir(staging,{mode:0o700});
  try {
    await symlink(row.database,join(staging,'store.db'),'file');
    await writeFile(join(staging,'meta.json'),JSON.stringify({schemaVersion:1,cwd:row.cwd,title:row.title}),{mode:0o600});
    await writeFile(join(staging,MARKER),JSON.stringify({version:1,database:row.database}),{mode:0o600});
    // A nonempty preexisting native directory is never replaced by rename.
    await rename(staging,target);
  }catch{throw new AgentError('CURSOR_SESSION_CONFLICT','无法建立 Cursor 原生会话目录映射；未覆盖原会话');}
  finally{await rm(staging,{recursive:true,force:true});}
}
