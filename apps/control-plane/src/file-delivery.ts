import type { ControlPlaneDatabase } from './db.js';
import type { Principal } from './auth.js';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { invariant } from './errors.js';

// Runs through the existing native command/exec permission and idle checks.
// No shell interpolation, no overwrite, no link following, bounded copy.
export const DELIVERY_COPY = `import os,sys,stat,hashlib
src,root,folder,name=sys.argv[1:]
assert os.path.realpath(src)==src and os.path.realpath(root)==root,'Linked paths are not supported'
f=os.open(src,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
 s=os.fstat(f)
 assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<=50*1024*1024,'Not a deliverable regular file (maximum 50 MiB)'
 r=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  os.mkdir(folder,0o700,dir_fd=r)
  d=os.open(folder,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=r)
  try:
   out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=d)
   try:
    h=hashlib.sha256(); n=0
    with os.fdopen(out,'wb') as w:
     while True:
      b=os.read(f,192*1024)
      if not b: break
      n+=len(b)
      assert n<=s.st_size,'Source changed during copy'
      w.write(b); h.update(b)
     w.flush(); os.fsync(w.fileno())
    a=os.fstat(f)
    assert (s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(a.st_size,a.st_mtime_ns,a.st_ctime_ns) and n==s.st_size,'Source changed during copy'
   except BaseException:
    os.unlink(name,dir_fd=d)
    raise
   print('DELIVERED',n,h.hexdigest())
  finally: os.close(d)
 finally: os.close(r)
finally: os.close(f)
`;

export function deliveryPlan(input: { path: string; root: string; platform: string; provider: string; sessionId: string; userId: string; mutationId: string }) {
  invariant(input.provider === 'codex' && ['darwin','linux'].includes(input.platform),409,'FILE_DELIVERY_UNSUPPORTED','自动交付目前支持 macOS / Linux 上的 Codex 会话；其他环境请将文件复制到项目内再下载。');
  invariant(input.path.startsWith('/') && !input.path.includes('\0') && input.path.length <= 1800,400,'FILE_PATH_INVALID','请选择一个绝对文件路径');
  const source=posix.normalize(input.path), name=posix.basename(source);
  invariant(!source.split('/').some(p=> /^(?:\.ssh|\.aws|\.codex|\.agentfleet|\.env(?:\..*)?|auth\.json|credentials(?:\..*)?)$/i.test(p)),403,'FILE_ACCESS_DENIED','账号、密钥及运行时私有文件不能作为交付文件');
  invariant(/\.(?:pdf|zip|mp4|mov|webm|png|jpe?g|webp|gif|txt|md|csv|json|xlsx|docx|pptx)$/i.test(name),400,'FILE_DELIVERY_TYPE_UNSUPPORTED','此文件类型暂不支持自动交付，请在项目内准备交付文件');
  const folder='agentfleet-delivery-'+createHash('sha256').update(JSON.stringify([input.userId,input.sessionId,input.mutationId,source])).digest('hex').slice(0,24);
  return { path:posix.join(input.root,folder,name), argv:['python3','-c',DELIVERY_COPY,source,input.root,folder,name] };
}

/** Reuse only confirmed, successful copies for this user and exact session/source.
 * Receipt/content retention controls the mapping lifetime; never search other sessions.
 */
export function deliveredPath(db: ControlPlaneDatabase, principal: Principal, sessionId: string, source: string,
  command: (id: string) => Record<string, unknown>): string | undefined {
  const rows=db.all<{command_id:string;body:string}>(`SELECT c.command_id,cc.body_json AS body FROM commands c
    JOIN command_contents cc ON cc.command_id=c.command_id AND cc.deleted_at IS NULL
    JOIN command_projection cp ON cp.command_id=c.command_id
    WHERE c.workspace_id=? AND c.actor_user_id=? AND c.logical_session_id=? AND c.type='codex.manage' AND cp.state='applied'
      AND json_extract(cc.body_json,'$.operation')='terminal.run'
      AND json_extract(cc.body_json,'$.arguments.argv[2]')=? AND json_extract(cc.body_json,'$.arguments.argv[3]')=?
    ORDER BY c.created_at DESC LIMIT 5`,principal.workspaceId,principal.userId,sessionId,DELIVERY_COPY,posix.normalize(source));
  for(const row of rows){
    const result=command(row.command_id).result as {codexResult?:{status?:string}}|null;
    if(result?.codexResult?.status!=='completed')continue;
    const argv=JSON.parse(row.body).arguments.argv as string[];
    return posix.join(argv[4]!,argv[5]!,argv[6]!);
  }
  return undefined;
}
