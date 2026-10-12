import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { sharedBrowsers, SHARED_BROWSER_TOOL } from './shared-browser.js';

const tokens=new Map<string,string>();
let server:Server|undefined;
let starting:Promise<number>|undefined;
export async function closeBrowserMcp():Promise<void> {
  const current=server;server=undefined;starting=undefined;tokens.clear();
  if(current)await new Promise<void>(resolve=>{current.close(()=>resolve());current.closeAllConnections();});
}
/** Loopback, unguessable, thread-bound MCP endpoint. Never accepts arbitrary target IDs from a tool call. */
export async function browserMcpUrl(threadId:string):Promise<string> {
  if(!starting)starting=new Promise((resolve,reject)=>{
    server=createServer(async(req,res)=>{
      const path=req.url?.split('?')[0]??'';
      const id=tokens.get(path);
      res.setHeader('Cache-Control','no-store');
      if(req.headers.origin||!/^127\.0\.0\.1:\d+$/.test(req.headers.host??'')||!id){res.writeHead(403);res.end();return;}
      if(req.method==='DELETE'){res.writeHead(204);res.end();return;}
      if(req.method!=='POST'){res.writeHead(405);res.end();return;}
      try {
        let body='';for await(const chunk of req){body+=chunk.toString();if(body.length>16000){res.writeHead(413);res.end();return;}}
        const message=JSON.parse(body);
        if(message.id===undefined){res.writeHead(202);res.end();return;}
        let result:unknown;
        if(message.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'agentfleet-browser',version:'1.0.0'}};
        else if(message.method==='ping')result={};
        else if(message.method==='tools/list')result={tools:[SHARED_BROWSER_TOOL]};
        else if(message.method==='tools/call'&&message.params?.name===SHARED_BROWSER_TOOL.name){
          try{result={content:[{type:'text',text:JSON.stringify(await sharedBrowsers.tool(id,message.params.arguments))}]};}
          catch(error){result={isError:true,content:[{type:'text',text:error instanceof Error?error.message:'网页操作未完成'}]};}
        }else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}}));return;}
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
      }catch{res.writeHead(400);res.end();}
    });
    const current=server;
    current.on('error',reject);current.listen(0,'127.0.0.1',()=>{current.unref();resolve((current.address() as {port:number}).port);});
  });
  const port=await starting;
  let path=[...tokens].find(([,id])=>id===threadId)?.[0];
  if(!path){path='/'+randomBytes(32).toString('hex');tokens.set(path,threadId);}
  return `http://127.0.0.1:${port}${path}`;
}
