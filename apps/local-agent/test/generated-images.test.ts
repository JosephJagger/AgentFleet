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
