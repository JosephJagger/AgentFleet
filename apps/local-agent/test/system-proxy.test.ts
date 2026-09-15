import test from "node:test";
import assert from "node:assert/strict";
import { codexNetworkEnvironment, parseMacSystemProxy } from "../src/system-proxy.js";

const macProxy = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
}`;

test("parses enabled macOS web proxies without guessing disabled settings", () => {
  assert.deepEqual(parseMacSystemProxy(macProxy), {
    HTTP_PROXY: "http://127.0.0.1:7890",
    HTTPS_PROXY: "http://127.0.0.1:7890",
  });
  assert.deepEqual(parseMacSystemProxy("HTTPEnable : 0\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890"), {});
});

test("passes the active macOS system proxy to Codex", async () => {
  const calls: string[] = [];
  const environment = await codexNetworkEnvironment({ CODEX_HOME: "/tmp/codex" }, "darwin", async (file, args) => {
    calls.push(file, ...args);
    return { stdout: macProxy };
  });
  assert.deepEqual(calls, ["/usr/sbin/scutil", "--proxy"]);
  assert.equal(environment.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(environment.NO_PROXY, "localhost,127.0.0.1,::1");
});

test("preserves explicit proxy configuration and leaves other platforms unchanged", async () => {
  let calls = 0;
  const runner = async () => { calls += 1; return { stdout: macProxy }; };
  const explicit = await codexNetworkEnvironment({ HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "localhost" }, "darwin", runner);
  assert.equal(explicit.HTTPS_PROXY, "http://proxy.example:8080");
  const linux = await codexNetworkEnvironment({}, "linux", runner);
  assert.deepEqual(linux, {});
  assert.equal(calls, 0);
});

test("ignores malformed proxy endpoints and scutil failures", async () => {
  assert.deepEqual(parseMacSystemProxy("HTTPEnable : 1\nHTTPProxy : bad host\nHTTPPort : 70000"), {});
  assert.deepEqual(await codexNetworkEnvironment({ HOME: "/tmp" }, "darwin", async () => { throw new Error("unavailable"); }), { HOME: "/tmp" });
});
