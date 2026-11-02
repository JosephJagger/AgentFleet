import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPlaneConfig } from "../src/config.js";
import { buildControlPlane } from "./server-fixture.js";

function config(webDistDir: string): ControlPlaneConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    databasePath: ":memory:",
    webDistDir,
    publicOrigin: "http://control-plane.test",
    allowedOrigins: new Set(["http://control-plane.test", "https://panel.example.test"]),
    adminEmail: "admin@example.test",
    adminPassword: "correct horse battery staple",
    cookieName: "agentfleet_test",
    cookieSecure: false,
    sessionTtlSeconds: 3600,
    controlLeaseTtlSeconds: 45,
    pairTtlSeconds: 600,
    challengeTtlSeconds: 60,
    ticketTtlSeconds: 30,
    heartbeatOfflineSeconds: 45,
    logLevel: "silent",
  };
}

test("static hosting preserves SPA routes without masking missing assets", async (t) => {
  const webDistDir = await mkdtemp(join(tmpdir(), "agentfleet-static-"));
  await writeFile(join(webDistDir, "index.html"), "<!doctype html><title>AgentFleet test shell</title>");
  await writeFile(join(webDistDir, "manifest.webmanifest"), "{}\n");
  await writeFile(join(webDistDir, "install"), "#!/bin/sh\nset -eu\n");
  await mkdir(join(webDistDir, "assets"));
  await writeFile(join(webDistDir, "assets", "index-aBc12345.js"), "export default 1;");
  await mkdir(join(webDistDir, "downloads"));
  await writeFile(join(webDistDir, "downloads", "manifest.json"), '{"schemaVersion":1}\n');
  await writeFile(join(webDistDir, "downloads", "agentfleet-linux-x64-0.1.0"), "release bytes");
  await writeFile(join(webDistDir, "downloads", "agentfleet-linux-x64-0.1.0.sha256"), "0".repeat(64));

  const { app } = await buildControlPlane(config(webDistDir));
  await app.ready();
  t.after(async () => app.close());

  const spaRoute = await app.inject({ method: "GET", url: "/sessions/session-1" });
  assert.equal(spaRoute.statusCode, 200);
  assert.equal(spaRoute.headers["permissions-policy"], "camera=(), microphone=(self), geolocation=()");
  assert.match(spaRoute.headers["content-security-policy"] ?? "", /connect-src 'self' ws:\/\/control-plane\.test wss:\/\/panel\.example\.test ws:\/\/127\.0\.0\.1:\*;/);
  assert.match(spaRoute.headers["content-security-policy"] ?? "", /media-src 'self' blob:/);
  assert.match(spaRoute.body, /AgentFleet test shell/);
  assert.match(spaRoute.headers["content-security-policy"] ?? "", /base-uri 'none'/);
  assert.match(spaRoute.headers["content-security-policy"] ?? "", /frame-ancestors 'none'/);

  const asset = await app.inject({ method: "GET", url: "/assets/index-aBc12345.js" });
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(spaRoute.headers["cache-control"], "no-cache");

  const manifest = await app.inject({ method: "GET", url: "/manifest.webmanifest" });
  assert.equal(manifest.statusCode, 200);
  assert.match(manifest.headers["content-type"] ?? "", /^application\/manifest\+json/);

  const installer = await app.inject({ method: "GET", url: "/install" });
  assert.equal(installer.statusCode, 200);
  assert.equal(installer.body, "#!/bin/sh\nset -eu\n");
  assert.match(installer.headers["content-type"] ?? "", /^(?:text\/x-shellscript|text\/plain)/);
  assert.equal(installer.headers["cache-control"], "no-cache");

  await unlink(join(webDistDir, "install"));
  const missingInstaller = await app.inject({ method: "GET", url: "/install" });
  assert.equal(missingInstaller.statusCode, 404, "/install must not receive the SPA shell when its file is absent");
  assert.equal(JSON.parse(missingInstaller.body).error.code, "STATIC_FILE_NOT_FOUND");

  const releaseManifest = await app.inject({ method: "GET", url: "/downloads/manifest.json" });
  assert.equal(releaseManifest.statusCode, 200);
  assert.equal(JSON.parse(releaseManifest.body).schemaVersion, 1);
  assert.match(releaseManifest.headers["content-type"] ?? "", /^application\/json/);
  assert.equal(releaseManifest.headers["cache-control"], "no-cache");

  for (const url of [
    "/downloads/agentfleet-linux-x64-0.1.0",
    "/downloads/agentfleet-linux-x64-0.1.0.sha256",
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
  }

  for (const url of ["/assets/missing.js", "/assets/index.js.map", "/favicon.ico"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 404, `${url} must not receive the SPA shell`);
    assert.equal(JSON.parse(response.body).error.code, "STATIC_FILE_NOT_FOUND");
  }

  for (const url of ["/install/missing", "/downloads", "/downloads/", "/downloads/missing", "/downloads/missing.sha256"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 404, `${url} must not receive the SPA shell`);
    assert.equal(JSON.parse(response.body).error.code, "STATIC_FILE_NOT_FOUND");
  }

  const missingApi = await app.inject({ method: "GET", url: "/api/not-a-route" });
  assert.equal(missingApi.statusCode, 404);
  assert.equal(JSON.parse(missingApi.body).error.code, "ROUTE_NOT_FOUND");
});

test('JSON read compression respects negotiation and keeps identity responses uncompressed', async t => {
  const webDistDir = await mkdtemp(join(tmpdir(), 'agentfleet-compress-'));
  await writeFile(join(webDistDir, 'index.html'), '<!doctype html>');
  const { app } = await buildControlPlane(config(webDistDir));
  t.after(()=>app.close());
  const data = { items: Array.from({length:100},(_,n)=>({id:n,text:'retained command output '.repeat(100)})) };
  app.get('/api/traffic-test',()=>data);
  app.get('/api/auth/traffic-test',()=>data);
  const plain=await app.inject({method:'GET',url:'/api/traffic-test'});
  const zipped=await app.inject({method:'GET',url:'/api/traffic-test',headers:{'accept-encoding':'br, gzip'}});
  const {gunzipSync}=await import('node:zlib');
  assert.equal(zipped.headers['content-encoding'],'gzip');
  assert.equal(zipped.headers['cache-control'],'no-store');
  assert.equal(zipped.headers.vary,'Accept-Encoding');
  assert.deepEqual(JSON.parse(gunzipSync(zipped.rawPayload).toString()),data);
  assert.ok(zipped.rawPayload.length < plain.rawPayload.length / 10);
  const denied=await app.inject({method:'GET',url:'/api/traffic-test',headers:{'accept-encoding':'gzip;q=0, br'}});
  assert.equal(denied.headers['content-encoding'],undefined);
  const auth=await app.inject({method:'GET',url:'/api/auth/traffic-test',headers:{'accept-encoding':'gzip'}});
  assert.equal(auth.headers['content-encoding'],undefined);
});
