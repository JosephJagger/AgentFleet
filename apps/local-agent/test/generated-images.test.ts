import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, link, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatedImageItem, resolveGeneratedImage } from "../src/generated-images.js";
import { MAX_GENERATED_IMAGE_BYTES, parseImages, validGeneratedImageUrl } from "../src/images.js";
import { CodexAppServer, type AppServerCallbacks, type AppEvent } from "../src/app-server.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const url = `data:image/png;base64,${png}`;
const base = { type: "imageGeneration", id: "call-image", status: "completed" };
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "generated-image-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, "generated_images", "thread-1"); await mkdir(directory, { recursive: true });
  const path = join(directory, "call-image.png");
  const environment = { CODEX_HOME: home };
  return { home, directory, path, environment };
}
test("native inline output renders full raster bytes and leaves input size limits unchanged", () => {
  const result = generatedImageItem({ ...base, result: png, revisedPrompt: "private", savedPath: "/private" });
  assert.deepEqual(result.content, [{ type: "image", url }]);
  assert.equal(result.imageState, "ready"); assert.equal(JSON.stringify(result).includes("private"), false);
  const large = `data:image/png;base64,${Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(150_000)]).toString("base64")}`;
  assert.equal(validGeneratedImageUrl(large), true); assert.throws(() => parseImages([large]));
  assert.equal(generatedImageItem({ ...base, result: large }).imageState, "ready");
  for (const result of ["https://tracking.test/image", "file:///secret", "data:image/svg+xml;base64,PHN2Zy8+", "invalid", "A".repeat(12_000_000)])
    assert.equal(generatedImageItem({ ...base, result }).imageState, "unavailable");
  assert.equal(generatedImageItem({ ...base, result: png, status: "failed" }).imageState, "failed");
  assert.deepEqual(generatedImageItem({ ...base, result: png, status: "in_progress" }).content, []);
});
test("fileId takes precedence and resolves only the matching native thread artifact", async t => {
  const f = await fixture(t); await writeFile(f.path, Buffer.from(png, "base64"));
  const item = { ...base, fileId: "file_fixture", result: "stale", savedPath: f.path };
  assert.deepEqual((await resolveGeneratedImage(item, "thread-1", f.environment)).content, [{ type: "image", url }]);
  assert.equal((await resolveGeneratedImage(item, "thread-2", f.environment)).imageState, "unavailable");
  assert.equal((await resolveGeneratedImage({ ...item, savedPath: "/etc/passwd" }, "thread-1", f.environment)).imageState, "unavailable");
  assert.equal((await resolveGeneratedImage(item, "../thread-1", f.environment)).imageState, "unavailable");
  assert.equal((await resolveGeneratedImage({ ...base, fileId: "file_fixture" }, "thread-1", f.environment)).imageState, "ready");
  await rm(f.path);
  assert.equal((await resolveGeneratedImage(item, "thread-1", f.environment)).imageState, "unavailable");
});
test("generated artifact reads reject symlinks, hardlinks, directories and oversized files", async t => {
  const f = await fixture(t); const outside = join(f.home, "secret.png"); await writeFile(outside, Buffer.from(png, "base64"));
  const item = { ...base, fileId: "file_fixture", savedPath: f.path };
  const check = async () => assert.equal((await resolveGeneratedImage(item, "thread-1", f.environment)).imageState, "unavailable");
  await symlink(outside, f.path); await check(); await rm(f.path);
  await link(outside, f.path); await check(); await rm(f.path);
  await mkdir(f.path); await check(); await rm(f.path, { recursive: true });
  await writeFile(f.path, ""); await truncate(f.path, MAX_GENERATED_IMAGE_BYTES + 1); await check(); await rm(f.path);
  await rm(f.directory, { recursive: true }); await symlink(f.home, f.directory);
  await writeFile(join(f.home, "call-image.png"), Buffer.from(png, "base64")); await check();
});
test("live generated-image completion persists before turn completion and survives both history readers", async t => {
  const f = await fixture(t); await writeFile(f.path, Buffer.from(png, "base64"));
  const events: AppEvent[] = [];
  const callbacks = { onEvent: async (event: AppEvent) => { events.push(event); }, findManagedThread: () => ({ nativeThreadId: "thread-1", appServerEpoch: "epoch" }), onVolatile: () => undefined } as unknown as AppServerCallbacks;
  const server = new CodexAppServer(callbacks, "epoch", f.environment);
  const internal = server as unknown as { handleLine(line: string): Promise<void>; initialized: boolean; child: object; request(method: string): Promise<unknown> };
  const item = { ...base, fileId: "file_fixture", savedPath: f.path };
  await Promise.all([
    internal.handleLine(JSON.stringify({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn", item } })),
    internal.handleLine(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn", status: "completed" } } })),
  ]);
  assert.deepEqual(events.map(event => event.type), ["item.completed", "turn.completed"]);
  assert.deepEqual((events[0]!.payload.item as Record<string, unknown>).content, [{ type: "image", url }]);
  internal.initialized = true; internal.child = {};
  internal.request = async method => method === "thread/read"
    ? { thread: { id: "thread-1", cwd: f.home, turns: [{ id: "turn", items: [item] }] } }
    : { data: [{ turnId: "turn", item }], nextCursor: null };
  const legacy = await server.readThread("thread-1");
  const paginated = await server.readHistoryPage("thread-1", null);
  assert.deepEqual(legacy.items[0]!.item, events[0]!.payload.item);
  assert.deepEqual(paginated.items[0]!.item, events[0]!.payload.item);
});

test("large originals use small metadata and bounded streaming without a file-size ceiling", async t => {
  const { streamGeneratedImage } = await import("../src/generated-image-stream.js");
  const f = await fixture(t);
  await writeFile(f.path, Buffer.from(png,"base64"));
  const size = 53 * 1024 * 1024;
  await truncate(f.path,size);
  const item = await resolveGeneratedImage({...base,fileId:"large-file"},"thread-1",f.environment);
  assert.equal(item.imageState,"streamed"); assert.equal(item.imageBytes,size);
  assert.ok(JSON.stringify(item).length < 300);
  const state = {nativeThreadBindings:{"thread-1":{logicalSessionId:"session",projectId:"project"}},managedThreads:{},projectContentPolicies:{},nativeDeletionTombstones:{}};
  const store = {snapshot:()=>state} as unknown as import("../src/store.js").StateStore;
  const request = {logicalSessionId:"session",projectId:"project",nativeThreadId:"thread-1",itemId:"call-image"};
  let received=0,chunks=0,waiting=false;
  const result = await streamGeneratedImage(store,request,{
    signal:new AbortController().signal,
    onStart:metadata=>{assert.equal(metadata.size,size);assert.equal(metadata.filename,"generated-image.png");},
    onChunk:async (chunk,sequence)=>{
      assert.equal(waiting,false); waiting=true;
      assert.ok(chunk.length<=192*1024);assert.equal(sequence,chunks++);received+=chunk.length;
      await new Promise(resolve=>setImmediate(resolve));waiting=false;
    },
  },f.environment);
  assert.equal(received,size);assert.equal(result.size,size);assert.equal(result.chunks,chunks);
  const callbacks={signal:new AbortController().signal,onStart:()=>{},onChunk:()=>{}};
  await assert.rejects(streamGeneratedImage(store,{...request,logicalSessionId:"other"},callbacks,f.environment),{code:"FILE_SESSION_BINDING_INVALID"});
  const abort = new AbortController();let count=0;
  await assert.rejects(streamGeneratedImage(store,request,{...callbacks,signal:abort.signal,onChunk:()=>{if(++count===2)abort.abort();}},f.environment),{name:"AbortError"});
  assert.equal(count,2);
});

test("relay waits for each image chunk acknowledgement and cancellation stops disk reads", async t => {
  const { RelayConnection } = await import("../src/relay.js");
  const f=await fixture(t);await writeFile(f.path,Buffer.from(png,"base64"));await truncate(f.path,10*1024*1024);
  const prior=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  t.after(()=>{if(prior===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=prior;});
  const state={nativeThreadBindings:{"thread-1":{logicalSessionId:"session",projectId:"project"}},managedThreads:{},projectContentPolicies:{},nativeDeletionTombstones:{}};
  const frames:Record<string,unknown>[]=[];
  const relay=new RelayConnection({runtime:{setCallbacks:()=>{}} as never,store:{snapshot:()=>state} as never,identity:{} as never,pairing:{} as never,requestedUrl:"http://fixture",logger:{info:()=>{},warn:()=>{}}});
  const internal=relay as unknown as {socket:unknown;reconciliationReady:boolean;handleMessage(event:{data:string}):Promise<void>;fileTransfers:Map<string,AbortController>};
  internal.socket={readyState:1,bufferedAmount:0,send:(data:string)=>frames.push(JSON.parse(data))};internal.reconciliationReady=true;
  const send=(value:unknown)=>internal.handleMessage({data:JSON.stringify(value)});
  const waitFor=async(predicate:()=>boolean)=>{for(let n=0;n<100&&!predicate();n++)await new Promise(r=>setTimeout(r,5));assert.equal(predicate(),true);};
  await send({type:"file.read",requestId:"request",logicalSessionId:"session",projectExternalId:"project",generatedImage:{nativeThreadId:"thread-1",itemId:"call-image"}});
  await waitFor(()=>frames.some(f=>f.type==="file.chunk"));
  await new Promise(r=>setTimeout(r,25));assert.equal(frames.filter(f=>f.type==="file.chunk").length,1);
  await send({type:"file.chunk.ack",requestId:"request",sequence:99});
  await new Promise(r=>setTimeout(r,25));assert.equal(frames.filter(f=>f.type==="file.chunk").length,1);
  await send({type:"file.chunk.ack",requestId:"request",sequence:0});
  await waitFor(()=>frames.filter(f=>f.type==="file.chunk").length===2);
  await send({type:"file.cancel",requestId:"request"});await waitFor(()=>internal.fileTransfers.size===0);
  assert.equal(frames.filter(f=>f.type==="file.chunk").length,2);assert.equal(frames.some(f=>f.type==="file.end"),false);
});
