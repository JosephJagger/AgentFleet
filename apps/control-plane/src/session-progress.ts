import type { ControlPlaneDatabase } from "./db.js";
import type { RegistryService } from "./registry.js";
import type { Principal } from "./auth.js";

export interface ProgressItem {
  id: string; kind: string; status: string; title: string; output?: string; updatedAt: string;
}
export interface SessionProgress {
  sessionId: string; nativeTurnId: string | null; state: string;
  source: "codex_app_server_events" | "claude_events"; freshness: "live" | "stale" | "unavailable";
  updatedAt: string | null; contentAvailable: boolean; waitingForApproval: boolean;
  items: ProgressItem[]; limited: boolean;
}
interface Stream {
  sessionId: string; segmentId: string; contentEpoch: number; turnId: string;
  itemId: string; type: string; text: string; at: number; truncated: boolean;
}
const terminalTypes = ["turn.completed", "turn.failed", "turn.interrupted"];
const text = (value: unknown, limit = 1000) => typeof value === "string" ? value.slice(0, limit) : "";

/** Read-only projections of native notifications. Never resume a writer or replay a command. */
export class SessionProgressService {
  private streams = new Map<string, Stream>();
  constructor(private db: ControlPlaneDatabase, private registry: RegistryService, private now = Date.now) {}
  private prune() {
    for (const [key, stream] of this.streams) if (this.now() - stream.at > 120_000) this.streams.delete(key);
    while (this.streams.size > 256) this.streams.delete(this.streams.keys().next().value!);
  }
  /** Called only after transport, epoch and thread binding validation. */
  record(sessionId: string, segmentId: string, turnId: string, itemId: string | undefined, type: string, content: string, truncated: boolean) {
    this.prune();
    const row = this.db.get<{content_epoch:number;sync_content:number}>(`SELECT s.content_epoch,p.sync_content FROM logical_sessions s JOIN projects p ON p.project_id=s.project_id
      JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.execution_segment_id=? AND e.ended_at IS NULL
      WHERE s.logical_session_id=? AND s.deleted_at IS NULL`,segmentId,sessionId);
    if (!row?.sync_content) return;
    const key=JSON.stringify([sessionId,segmentId,row.content_epoch,turnId,itemId??"diff",type]);
    const previous=this.streams.get(key);
    const combined=type==='turn_diff.delta'?content:(previous?.text??'')+content;
    this.streams.delete(key);
    this.streams.set(key,{sessionId,segmentId,contentEpoch:row.content_epoch,turnId,itemId:itemId??'diff',type,text:combined.slice(-4000),at:this.now(),truncated:truncated||combined.length>4000||Boolean(previous?.truncated)});
    this.prune();
  }
  read(principal: Principal, sessionId: string, requestedTurn?: string | null): SessionProgress {
    const session=this.registry.getSession(principal,sessionId); // enforce workspace access before any content reads
    const machine=this.registry.getMachine(principal,session.machineId);
    const policy=this.db.get<{sync_content:number}>("SELECT sync_content FROM projects WHERE project_id=?",session.projectId);
    const turnId=requestedTurn===undefined?session.activeTurnId:requestedTurn;
    const online=machine.reachability==='online' && session.reachability==='live' && Boolean(machine.lastHeartbeatAt && this.now()-Date.parse(machine.lastHeartbeatAt)<90_000);
    this.prune();
    if (!policy?.sync_content) for (const [key,value] of this.streams) if(value.sessionId===sessionId)this.streams.delete(key);
    const rows=turnId?this.db.all<{type:string;native_item_id:string|null;body_json:string|null;received_at:string;payload_state:string}>(`SELECT e.type,e.native_item_id,e.received_at,e.payload_state,
      CASE WHEN e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN b.body_json ELSE NULL END AS body_json
      FROM durable_events e LEFT JOIN content_blobs b USING(payload_ref)
      WHERE e.logical_session_id=? AND e.native_turn_id=? ORDER BY e.session_seq DESC LIMIT 120`,sessionId,turnId):[];
    const end=rows.find(row=>terminalTypes.includes(row.type));
    let state=requestedTurn===null?'awaiting_turn':session.executionState;
    if(end)state=end.type==='turn.failed'?'failed':end.type==='turn.interrupted'?'interrupted':'completed';
    else if (requestedTurn && requestedTurn!==session.activeTurnId) state='unknown';
    const items=new Map<string,ProgressItem>();
    const completed=new Set<string>();
    const hidden=new Set(rows.filter(row=>!row.body_json).map(row=>row.native_item_id).filter((id):id is string=>Boolean(id)));
    let limited=rows.length===120||rows.some(row=>!row.body_json);
    let updatedAt=rows[0]?.received_at??null;
    if(policy?.sync_content) for(const row of [...rows].reverse()) {
      if(!row.body_json)continue;
      const payload=JSON.parse(row.body_json);const item=payload.item;
      if(!item||!['item.started','item.completed'].includes(row.type))continue;
      const id=row.native_item_id??text(item.id);if(!id||hidden.has(id))continue;
      if(completed.has(id)&&row.type==='item.started')continue;
      const status=row.type==='item.completed'?(item.status==='failed'||item.status==='declined'?item.status:'completed'):'running';
      let title='',output='';
      if(item.type==='commandExecution'){title=text(item.command);output=text(item.aggregatedOutput,4000);}
      else if(item.type==='fileChange'){
        const changes=Array.isArray(item.changes)?item.changes:[];
        title=changes.slice(0,4).map((change:{path?:unknown})=>text(change.path,200)).join(', ');
        output=changes.slice(0,2).map((change:{diff?:unknown})=>text(change.diff,2000)).join('\n');
      } else if(item.type==='agentMessage'||item.type==='plan')title=text(item.text);
      else continue; // never expose raw reasoning or arbitrary tool arguments
      if(row.type==='item.completed')completed.add(id);
      items.delete(id);items.set(id,{id,kind:item.type,status,title, ...(output?{output}:{}),updatedAt:row.received_at});
    }
    if(policy?.sync_content && !end && turnId===session.activeTurnId) for(const stream of this.streams.values()) {
      if(stream.sessionId!==sessionId||stream.segmentId!==session.executionSegmentId||stream.contentEpoch!==session.contentEpoch||stream.turnId!==turnId||hidden.has(stream.itemId)||completed.has(stream.itemId))continue;
      const previous=items.get(stream.itemId);
      const kind=stream.type==='command_output.delta'?'commandExecution':stream.type==='turn_diff.delta'?'fileChange':'agentMessage';
      const at=new Date(stream.at).toISOString();
      items.delete(stream.itemId);items.set(stream.itemId,{id:stream.itemId,kind,status:'running',title:kind==='agentMessage'?stream.text:previous?.title??'',...(kind==='agentMessage'?{}:{output:stream.text}),updatedAt:at});
      if(!updatedAt||at>updatedAt)updatedAt=at;
      limited ||= stream.truncated;
    }
    const waitingForApproval=Boolean(turnId && turnId===session.activeTurnId && this.db.get("SELECT 1 FROM approvals WHERE logical_session_id=? AND state='pending' LIMIT 1",sessionId));
    const all=[...items.values()];
    return {sessionId,nativeTurnId:turnId,state,source:session.provider==='claude'?'claude_events':'codex_app_server_events',freshness:!turnId?'unavailable':online&&!end?'live':'stale',updatedAt,contentAvailable:Boolean(policy?.sync_content),waitingForApproval,items:all.slice(-8),limited:limited||all.length>8};
  }
}
