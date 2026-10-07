import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "../src/projects.js";
import { projectWorkspaceFiles } from "../src/project-workspace-files.js";
import { parseCodexOperation } from "../src/codex-operations.js";
import { executeCodexOperation } from "../src/codex-operation-executor.js";

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "af-workspace-"));
  const root = join(dir, "project"); await mkdir(root);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = await resolveProject(root, "project");
  return { dir, root, run: (operation: string, args: Record<string, unknown> = {}) => projectWorkspaceFiles(parseCodexOperation({ operation, arguments: args }), project) };
}
test("text edit detects concurrent changes and preserves recoverable originals", async t => {
  const { root, run } = await fixture(t);
  await writeFile(join(root, "hello.txt"), "  original\n");
  const opened = await run("files.read", { path: "hello.txt" });
  const revision = opened.rows[0]!.detail;
  assert.equal(opened.rows[1]!.detail, "  original\n");
  await writeFile(join(root, "hello.txt"), "changed by Codex");
  await assert.rejects(run("files.write", { path: "hello.txt", text: "overwrite", revision, confirmed: true }), /修改/);
  assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "changed by Codex");
  const current = await run("files.read", { path: "hello.txt" });
  await run("files.write", { path: "hello.txt", text: "", revision: current.rows[0]!.detail, confirmed: true });
  assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "");
  const backups = await run("files.trash");
  assert.equal(backups.rows.length, 1);
  await run("files.restore", { backup: backups.rows[0]!.name, destination: "restored.txt", confirmed: true });
  assert.equal(await readFile(join(root, "restored.txt"), "utf8"), "changed by Codex");
  await assert.rejects(run("files.restore", { backup: backups.rows[0]!.name, destination: "restored.txt", confirmed: true }), /EEXIST/);
});
test("outside paths, links, secrets, binary and oversized files cannot be edited", async t => {
  const { dir, root, run } = await fixture(t);
  await writeFile(join(dir, "outside.txt"), "secret");
  await symlink(join(dir, "outside.txt"), join(root, "linked.txt"));
  await writeFile(join(root, ".env"), "secret");
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(join(root, "large"), "x".repeat(48001));
  for (const path of ["../outside.txt", "linked.txt", ".env", "binary", "large"]) await assert.rejects(run("files.read", { path }));
  await assert.rejects(run("files.create", { path: "../new.txt", text: "x", confirmed: true }));
});
test("remove is recoverable and create never overwrites", async t => {
  const { root, run } = await fixture(t);
  await run("files.create", { path: "new.txt", text: "keep", confirmed: true });
  await assert.rejects(run("files.create", { path: "new.txt", text: "lost", confirmed: true }), /EEXIST/);
  const revision = (await run("files.read", { path: "new.txt" })).rows[0]!.detail;
  await run("files.remove", { path: "new.txt", revision, confirmed: true });
  await assert.rejects(readFile(join(root, "new.txt")), /ENOENT/);
  assert.equal((await run("files.trash")).rows.length, 1);
});
test("native configuration only exposes safe keys and refuses stale versions", async () => {
  const calls: string[] = [];
  const rpc = async (method: string, args: Record<string, unknown> | null) => {
    calls.push(method);
    if (method === "config/read") return { config: { model: "model", model_verbosity: "low", api_key: "secret" }, origins: {}, layers: [{ name: { type: "user" }, version: "v2" }] };
    assert.equal(args?.expectedVersion, "v2");
    assert.equal((args?.edits as unknown[]).length, 2);
    return { status: "ok" };
  };
  const run = (operation: string, args: Record<string, unknown> = {}) => executeCodexOperation({ operation, arguments: args }, "", "mutation", rpc, async () => {});
  assert.ok(!JSON.stringify(await run("config.read")).includes("secret"));
  await assert.rejects(run("config.save", { version: "v1", summary: "auto", verbosity: "high", confirmed: true }), /变化/);
  assert.ok(!calls.includes("config/batchWrite"));
  assert.equal((await run("config.save", { version: "v2", summary: "auto", verbosity: "high", confirmed: true })).status, "savedRequiresReconnect");
});

test("interactive terminal is bound to execution segment and reports completion", async t => {
  const { WorkspaceTerminals } = await import("../src/workspace-terminals.js");
  const { root } = await fixture(t);
  const project = await resolveProject(root, "project");
  const terminals = new WorkspaceTerminals();
  const thread = { nativeThreadId: "thread", projectId: project.id, executionSegmentId: "segment", appServerEpoch: "epoch", policyVersion: "remote-restricted-v1" as const, policyVerified: true, contentEpoch: 1, createdAt: new Date().toISOString() };
  let finish: (value: unknown) => void = () => {};
  const methods: string[] = [];
  const activities: boolean[] = [];
  const rpc = async (method: string) => { methods.push(method); if (method === "command/exec") return new Promise(resolve => { finish = resolve; }); return {}; };
  const run = (operation: string, args: Record<string, unknown> = {}) => terminals.run(parseCodexOperation({ operation, arguments: args }), thread, project, rpc, (_id, active) => activities.push(active));
  const started = await run("terminal.start", { command: "cat", confirmed: true });
  const processId = started.rows[0]!.detail;
  terminals.output({ processId, deltaBase64: Buffer.from("hello\n").toString("base64") });
  assert.equal((await run("terminal.status", { processId })).rows[2]!.detail, "hello\n");
  await assert.rejects(terminals.run(parseCodexOperation({ operation: "terminal.stop", arguments: { processId, confirmed: true } }), { ...thread, executionSegmentId: "other" }, project, rpc), /不属于/);
  await run("terminal.write", { processId, text: "\n", confirmed: true });
  await run("terminal.resize", { processId, rows: 30, cols: 100, confirmed: true });
  assert.deepEqual(methods, ["command/exec", "command/exec/write", "command/exec/resize"]);
  finish({ exitCode: 0 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await run("terminal.status", { processId })).status, "completed");
  assert.deepEqual(activities, [true, false]);
});
