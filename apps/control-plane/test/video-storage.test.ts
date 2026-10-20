import test from "node:test";
import assert from "node:assert/strict";
import { VideoStorage, type VideoStorageConfig } from "../src/video-storage.js";
import type { Principal } from "../src/auth.js";
import type { ControlPlaneDatabase } from "../src/db.js";
import type { S3Client } from "@aws-sdk/client-s3";

const config: VideoStorageConfig = { workspaceId: "w", label: "host", endpoint: "https://storage.example", bucket: "video-output", region: "garage", prefix: "grok-videos/", quotaBytes: 5e9, accessKeyId: "private-key", secretAccessKey: "private-secret" };
const principal = { workspaceId: "w", userId: "u", clientSessionId: "c" } as Principal;
const date = new Date("2026-10-19T00:00:00Z");
const item = { key: "grok-videos/one.mp4", etag: '"etag"', modifiedAt: date.toISOString(), bytes: 42, confirm: true };
function fixture(response: (name: string, input: Record<string, unknown>) => unknown) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const audit: unknown[] = [];
  const client = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    calls.push({ name: command.constructor.name, input: command.input }); return response(command.constructor.name, command.input);
  } } as unknown as Pick<S3Client, "send">;
  const db = { audit: (value: unknown) => audit.push(value) } as unknown as ControlPlaneDatabase;
  return { service: new VideoStorage(db, config, client, () => date.getTime() + 120_000), calls, audit };
}
test("video listing is workspace scoped, bounded and never returns credentials", async () => {
  const { service, calls } = fixture(() => ({ Contents: [{ Key: item.key, Size: 42, ETag: item.etag, LastModified: date }], IsTruncated: true, NextContinuationToken: "next" }));
  assert.equal((await service.list({ ...principal, workspaceId: "other" })).configured, false);
  assert.equal(calls.length, 0);
  const result = await service.list(principal, "cursor");
  assert.equal(result.nextCursor, "next"); assert.equal(result.items.length, 1);
  assert.equal(calls[0]!.input.MaxKeys, 20); assert.equal(calls[0]!.input.Prefix, config.prefix);
  assert.equal(calls[0]!.input.ContinuationToken, "cursor");
  assert.equal(JSON.stringify(result).includes("private-"), false);
  await assert.rejects(service.list(principal, {}), { code: "VIDEO_STORAGE_CURSOR_INVALID" });
});
test("deletion rejects other workspaces, prefixes, stale snapshots, unconfirmed and recent objects", async () => {
  const { service, calls } = fixture(() => ({ ETag: '"changed"', ContentLength: 42, LastModified: date }));
  await assert.rejects(service.remove({ ...principal, workspaceId: "other" }, item), { code: "VIDEO_STORAGE_UNAVAILABLE" });
  for (const key of ["elsewhere/a.mp4", "grok-videos/../x", "grok-videos/", "grok-videos/a\nb"])
    await assert.rejects(service.remove(principal, { ...item, key }), { code: "VIDEO_STORAGE_KEY_INVALID" });
  await assert.rejects(service.remove(principal, { ...item, confirm: false }), { code: "VIDEO_STORAGE_DELETE_INVALID" });
  assert.equal(calls.length, 0);
  await assert.rejects(service.remove(principal, item), { code: "VIDEO_STORAGE_CHANGED" });
  assert.equal(calls.some(x => x.name === "DeleteObjectCommand"), false);
  const recent = fixture(() => ({ ETag: item.etag, ContentLength: 42, LastModified: new Date(date.getTime() + 119_000) }));
  await assert.rejects(recent.service.remove(principal, { ...item, modifiedAt: new Date(date.getTime() + 119_000).toISOString() }), { code: "VIDEO_STORAGE_RECENT" });
});
test("deletes only the confirmed exact key and audits request and completion", async () => {
  const { service, calls, audit } = fixture(name => name === "HeadObjectCommand" ? { ETag: item.etag, ContentLength: 42, LastModified: date } : {});
  assert.deepEqual(await service.remove(principal, { ...item, modifiedAt: "2026-10-19T00:00:00.123Z" }), { deleted: true });
  assert.deepEqual(calls.map(x => x.name), ["HeadObjectCommand", "DeleteObjectCommand"]);
  assert.equal(calls[1]!.input.Key, item.key); assert.equal(audit.length, 2);
});
test("storage failures are sanitized and never reported as deleted", async () => {
  const { service, audit } = fixture(() => { throw new Error("private-secret request signature"); });
  await assert.rejects(service.remove(principal, item), { code: "VIDEO_STORAGE_FAILED" }); assert.equal(audit.length, 0);
});
test("video endpoints enforce existing authentication and CSRF", async t => {
  const { buildControlPlane } = await import("../src/server.js");
  const { loadConfig } = await import("../src/config.js");
  const origin = "http://example.test";
  const { app } = await buildControlPlane({ ...loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "owner@example.test", ADMIN_PASSWORD: "correct horse battery staple", PUBLIC_ORIGIN: origin, COOKIE_SECURE: "false", LOG_LEVEL: "silent" }), databasePath: ":memory:" });
  t.after(() => app.close());
  const base = "/api/settings/video-storage";
  assert.equal((await app.inject({ method: "GET", url: base })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: base + "/delete", payload: item })).statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email: "owner@example.test", password: "correct horse battery staple" } });
  const cookie = login.cookies.map(x => `${x.name}=${x.value}`).join("; ");
  assert.equal((await app.inject({ method: "POST", url: base + "/delete", headers: { cookie, origin }, payload: item })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: base + "/download", headers: { cookie, origin }, payload: {key:item.key} })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: base, headers: { cookie } })).json().configured, false);
});

test('inline previews accept only configured workspace objects and bounded safe media',async()=>{
 const {service,calls}=fixture(name=>name==='HeadObjectCommand'?{ContentLength:4,ETag:'"v1"'}:{Body:{transformToByteArray:async()=>new Uint8Array([1,2,3,4])}});
 for(const source of ['https://other.example/video-output/grok-videos/a.mp4','https://storage.example/other/grok-videos/a.mp4','https://storage.example/video-output/other/a.mp4','https://storage.example/video-output/grok-videos/a.html'])await assert.rejects(service.preview(principal,source));
 assert.equal(calls.length,0);
 await assert.rejects(service.preview({...principal,workspaceId:'other'},'https://storage.example/video-output/grok-videos/a.mp4'));
 const result=await service.preview(principal,'https://storage.example/video-output/grok-videos/a.mp4');
 assert.equal(result.mime,'video/mp4');assert.equal(result.bytes.length,4);assert.equal(calls[1]!.input.IfMatch,'"v1"');assert.equal(calls[1]!.input.Range,'bytes=0-3');
 const large=fixture(()=>({ContentLength:26*1024*1024,ETag:'"v1"'}));await assert.rejects(large.service.preview(principal,'https://storage.example/video-output/grok-videos/a.mp4'),{code:'VIDEO_PREVIEW_LIMIT'});assert.equal(large.calls.length,1);
});
