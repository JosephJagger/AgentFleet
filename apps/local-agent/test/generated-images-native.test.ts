import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexAppServer, type AppServerCallbacks } from "../src/app-server.js";

test("real Codex restores inline and file-backed generated images from a persisted rollout", { skip: !process.env.AGENTFLEET_NATIVE_TEST, timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "generated-image-native-")); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), cwd = join(root, "project"), day = join(home, "sessions", "2026", "10", "26");
  await mkdir(day, { recursive: true }); await mkdir(cwd);
  const id = randomUUID(), turn = randomUUID(), at = "2026-10-26T00:00:00.000Z";
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const directory = join(home, "generated_images", id); await mkdir(directory, { recursive: true });
  const savedPath = join(directory, "file-image.png"); await writeFile(savedPath, Buffer.from(png, "base64"));
  const rows = [
    { type: "session_meta", payload: { id, timestamp: at, cwd, originator: "codex_cli_rs", cli_version: "0.164.0", source: "cli", model_provider: "openai" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turn } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic image history only." }] } },
    { type: "event_msg", payload: { type: "image_generation_end", call_id: "inline-image", status: "completed", result: png } },
    { type: "event_msg", payload: { type: "image_generation_end", call_id: "file-image", status: "completed", fileId: "file_fixture", saved_path: savedPath } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: "Fixture complete." } },
  ];
  await writeFile(join(day, `rollout-2026-10-26T00-00-00-${id}.jsonl`), rows.map(row => JSON.stringify({ timestamp: at, ...row })).join("\n") + "\n");
  const callbacks = { findManagedThread: () => undefined, findProject: () => undefined, onEvent: async () => undefined, onVolatile: () => undefined, onApproval: async () => undefined, onApprovalResolved: async () => undefined, onExit: async () => undefined } as AppServerCallbacks;
  const server = new CodexAppServer(callbacks, undefined, { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, AGENTFLEET_CODEX_EXECUTABLE: process.env.AGENTFLEET_NATIVE_CODEX });
  try {
    await server.start(); const history = await server.readThread(id);
    const images = history.items.filter(entry => entry.item?.type === "imageGeneration");
    assert.equal(images.length, 2, JSON.stringify(history.items));
    for (const entry of images) assert.deepEqual(entry.item?.content, [{ type: "image", url: `data:image/png;base64,${png}` }]);
    await server.stop(); await server.start();
    assert.deepEqual((await server.readThread(id)).items.filter(entry => entry.item?.type === "imageGeneration"), images);
  } finally { await server.stop(); }
});
