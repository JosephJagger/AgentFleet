import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {setImmediate as yieldToIO} from 'node:timers/promises';
import {AgentError} from './errors.js';
import {isRecord} from './util.js';

export interface AcpConnectionOptions {
  executable: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv;
  notification(method:string,params:Record<string,unknown>): Promise<void> | void;
  request(method:string,params:Record<string,unknown>): Promise<unknown>;
  exit(error:Error): void;
  processExited?(): void;
}
/** One owned stdio connection. No shell, network listener, or credential persistence. */
export class AcpConnection {
  private child: ChildProcessWithoutNullStreams | undefined;
  private sequence = 0;
  private buffered = Buffer.alloc(0);
  private ended = false;
  private processClosed = false;
  private readonly closed = Promise.withResolvers<void>();
  private events = Promise.resolve();
  private readonly pending = new Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  constructor(private readonly options: AcpConnectionOptions) {}
  get pid() { return this.child?.pid; }
  get closing() { return this.ended && !this.processClosed; }
  start() {
    if (this.child || this.ended) throw new AgentError('ACP_CONNECTION_STATE','Connection cannot be started twice');
    this.child = spawn(this.options.executable,this.options.args,{cwd:this.options.cwd,env:this.options.env??process.env,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
    this.child.stdin.on('error',()=>this.fail(new AgentError('ACP_WRITE_FAILED','Native input stream failed')));
    this.child.stdout.on('data',(chunk:Buffer)=>this.consume(chunk));
    this.child.stderr.on('data',()=>{/* Native stderr can contain credentials; drain without persisting. */});
    this.child.on('error',()=>this.fail(new AgentError('ACP_START_FAILED','Official CLI could not be started')));
    this.child.once('close',()=>{
      this.processClosed=true;
      this.fail(new AgentError('ACP_DISCONNECTED','Native agent disconnected; task outcome must be reconciled'));
      this.options.processExited?.();this.closed.resolve();
    });
  }
  private send(value:unknown) {
    if (this.ended || !this.child?.stdin.writable) throw new AgentError('ACP_DISCONNECTED','Native agent is not connected');
    const data=JSON.stringify(value)+'\n';
    if (Buffer.byteLength(data)>4*1024*1024) throw new AgentError('ACP_MESSAGE_LIMIT','Protocol message is too large');
    this.child.stdin.write(data,error=>{if(error)this.fail(new AgentError('ACP_WRITE_FAILED','Unable to write to native agent'));});
  }
  call(method:string,params:Record<string,unknown>,timeoutMs=30000):Promise<unknown> {
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new AgentError('ACP_TIMEOUT',`${method} did not return; do not replay a mutating request`));},timeoutMs);
      timer.unref();this.pending.set(id,{resolve,reject,timer});
      try { this.send({jsonrpc:'2.0',id,method,params}); } catch(error) { clearTimeout(timer);this.pending.delete(id);reject(error); }
    });
  }
  notify(method:string,params:Record<string,unknown>) {this.send({jsonrpc:'2.0',method,params});}
  private consume(chunk:Buffer) {
    if(this.ended)return;
    this.buffered=Buffer.concat([this.buffered,chunk]);
    while(true) {
      const end=this.buffered.indexOf(10);
      if(end<0)break;
      if(end>4*1024*1024){this.fail(new AgentError('ACP_MESSAGE_LIMIT','Native message exceeded size limit'));return;}
      const line=this.buffered.subarray(0,end).toString('utf8').trim();this.buffered=this.buffered.subarray(end+1);
      if(!line)continue;
      let message:unknown;try{message=JSON.parse(line);}catch{this.fail(new AgentError('ACP_PROTOCOL','Native stdout contained invalid JSON'));return;}
      if(!isRecord(message)||message.jsonrpc!=='2.0'){this.fail(new AgentError('ACP_PROTOCOL','Invalid JSON-RPC envelope'));return;}
      const m=message;
      if(typeof m.method==='string') {
        const params=isRecord(m.params)?m.params:{};
        if(typeof m.id==='number'||typeof m.id==='string') {
          // A permission request must not block the notification queue or cancel handling.
          void this.options.request(m.method,params).then(result=>{if(!this.ended)this.send({jsonrpc:'2.0',id:m.id,result});},()=>{if(!this.ended)this.send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Request unsupported or cancelled'}});}).catch(()=>undefined);
        } else {
          this.events=this.events.then(async()=>{await this.options.notification(String(m.method),params);await yieldToIO();});
          void this.events.catch(()=>this.fail(new AgentError('ACP_EVENT_FAILED','Native event could not be persisted')));
        }
      } else if(typeof m.id==='number') {
        const pending=this.pending.get(m.id);if(!pending)continue;
        this.pending.delete(m.id);clearTimeout(pending.timer);
        // Complete responses only after all earlier streamed events have been stored.
        void this.events.then(()=>{
          if(isRecord(m.error))pending.reject(new AgentError('ACP_REMOTE_ERROR',`Native request rejected (${String(m.error.code)})`));
          else if(Object.hasOwn(m,'result'))pending.resolve(m.result);
          else pending.reject(new AgentError('ACP_PROTOCOL','Missing RPC result'));
        },pending.reject);
      }
    }
    if(this.buffered.length>4*1024*1024)this.fail(new AgentError('ACP_MESSAGE_LIMIT','Native message exceeded size limit'));
  }
  private fail(error:Error) {
    if(this.ended)return;this.ended=true;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
    this.child?.stdin.destroy();this.child?.kill();this.options.exit(error);
  }
  close() { this.fail(new AgentError('ACP_CLOSED','Connection released')); }
  async closeAndWait(timeoutMs=10000) {
    this.close();
    if(!this.child||this.processClosed)return;
    let timer:NodeJS.Timeout|undefined;
    try {
      await Promise.race([this.closed.promise,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new AgentError('PROVIDER_RELEASE_PENDING','Native process is still closing; no replacement task was sent. Retry after it exits.')),timeoutMs);
      })]);
    } finally {if(timer)clearTimeout(timer);}
  }
}
