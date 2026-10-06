import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { streamProjectFile } from "../src/project-files.js";
import { resolveProject } from "../src/projects.js";
import { StateStore } from "../src/store.js";
import type { ManagedThread } from "../src/types.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-project-file-"));
  const root = join(directory, "project");
  const store = new StateStore(join(directory, "state"));
  await mkdir(root);
  await store.initialize();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const project = await resolveProject(root, "project");
  await store.update((state) => { state.projects.push(project); });
  const thread = {
    nativeThreadId: "native", projectId: project.id, sessionCwd: project.root,
    logicalSessionId: "logical", executionSegmentId: "segment", appServerEpoch: "epoch",
    policyVersion: "remote-restricted-v1", policyVerified: true, contentEpoch: 1,
    createdAt: new Date().toISOString(),
  } satisfies ManagedThread;
  await store.setManagedThread(thread);
  return { directory, root, store, project };
}

test("streams arbitrary project file bytes through an exact Session binding", async (t) => {
  const { root, store, project } = await fixture(t);
  const path = join(root, "PRD.bin");
  const expected = Buffer.concat([Buffer.from("PRD\0", "utf8"), Buffer.alloc(400_000, 0xa5)]);
  await writeFile(path, expected);
  const chunks: Buffer[] = [];
  let metadata: { filename: string; size: number } | undefined;
  const result = await streamProjectFile(store, { logicalSessionId: "logical", projectId: project.id, path }, {
    signal: new AbortController().signal,
    onStart: (value) => { metadata = value; },
    onChunk: (chunk) => { chunks.push(chunk); },
  });
  assert.deepEqual(metadata, { filename: "PRD.bin", size: expected.length });
  assert.deepEqual(Buffer.concat(chunks), expected);
  assert.equal(result.size, expected.length);
  assert.equal(result.chunks, 3);
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
});

test("rejects paths outside the bound project, including an in-project symlink", async (t) => {
  const { directory, root, store, project } = await fixture(t);
  const outside = join(directory, "secret.txt");
  const link = join(root, "linked-secret.txt");
  await writeFile(outside, "secret");
  await symlink(outside, link);
  const callbacks = { signal: new AbortController().signal, onStart() {}, onChunk() {} };
  await assert.rejects(streamProjectFile(store, { logicalSessionId: "logical", projectId: project.id, path: outside }, callbacks), (error: unknown) => (error as { code?: string }).code === "FILE_OUTSIDE_PROJECT");
  await assert.rejects(streamProjectFile(store, { logicalSessionId: "logical", projectId: project.id, path: "../secret.txt" }, callbacks), (error: unknown) => (error as { code?: string }).code === "FILE_OUTSIDE_PROJECT");
  await assert.rejects(streamProjectFile(store, { logicalSessionId: "logical", projectId: project.id, path: link }, callbacks), (error: unknown) => (error as { code?: string }).code === "FILE_OUTSIDE_PROJECT");
  await assert.rejects(streamProjectFile(store, { logicalSessionId: "another", projectId: project.id, path: link }, callbacks), (error: unknown) => (error as { code?: string }).code === "FILE_SESSION_BINDING_INVALID");
});

test("downloads only native images belonging to the bound Codex thread", async (t) => {
  const { directory, store, project } = await fixture(t);
  const threadId = "01a10f43-0761-7b51-b9ce-d3308bd28d99";
  const thread = store.snapshot().managedThreads.native!;
  await store.setManagedThread({ ...thread, nativeThreadId: threadId, logicalSessionId: "images" });
  const home = join(directory, "custom-codex-home");
  const images = join(home, "generated_images", threadId);
  await mkdir(images, { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const path = join(images, "exec-image.png");
  await writeFile(path, png);
  const received: Buffer[] = [];
  const callbacks = { signal: new AbortController().signal, onStart() {}, onChunk(chunk: Buffer) { received.push(chunk); } };
  const request = { logicalSessionId: "images", projectId: project.id, path };
  await streamProjectFile(store, request, callbacks, home);
  assert.deepEqual(Buffer.concat(received), png);
  const rejected = (candidate: string, session = "images") => assert.rejects(
    streamProjectFile(store, { ...request, path: candidate, logicalSessionId: session }, callbacks, home),
    (error: unknown) => (error as { code?: string }).code === "FILE_OUTSIDE_PROJECT",
  );
  await rejected(path, "logical");
  const fake = join(images, "secret.png");
  await writeFile(fake, "not an image");
  await rejected(fake);
  const other = join(home, "generated_images", "01a10f43-0761-7b51-b9ce-d3308bd28d98");
  await mkdir(other);
  await writeFile(join(other, "other.png"), png);
  await symlink(join(other, "other.png"), join(images, "linked.png"));
  await rejected(join(images, "linked.png"));
  await rejected(join(other, "other.png"));
  await writeFile(join(home, "auth.json"), "secret");
  await rejected(join(home, "auth.json"));
  await link(path, join(images, "hardlink.png"));
  await rejected(join(images, "hardlink.png"));
  await rm(join(images, "hardlink.png"));
  const moved = join(directory, "redirected");
  await rename(images, moved);
  await symlink(moved, images);
  await rejected(path);
  await rm(images);
  await rename(moved, images);
  await store.update(state => { state.projects[0]!.provider = "claude"; });
  await rejected(path);
});
