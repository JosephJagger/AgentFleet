import test from "node:test";
import assert from "node:assert/strict";
import { buildReferenceFiles, parseReferences } from "../src/session-reference-files.js";
import type { ControlPlaneDatabase } from "../src/db.js";
import type { CoordinationService } from "../src/coordination.js";
import type { Principal } from "../src/auth.js";

const id = `ls_${"a".repeat(32)}`;
const principal = { workspaceId: "ws_1" } as Principal;
const row = { title: "Source", host_name: "Host", project_alias: "Project", projection_epoch: 1, content_epoch: 2, next_session_seq: 4, history_completeness: "partial" };
function event(seq: number, type: string, text: string) { return { sessionSeq: seq, payloadState: "present", payload: { item: type === "userMessage" ? { type, content: [{ type: "text", text }] } : { type, text } } }; }

test("creates an ordered, scoped file without model calls or command output", () => {
  const db = { get: (_sql: string, sourceId: string, workspaceId: string) => sourceId === id && workspaceId === principal.workspaceId ? row : undefined } as unknown as ControlPlaneDatabase;
  const coordination = { historyPage: (_principal: Principal, sourceId: string, options: { beforeSeq?: number }) => {
    assert.equal(sourceId, id);
    return options.beforeSeq ? { items: [event(1, "userMessage", "first")], nextBeforeSeq: null, throughSeq: 3 } : { items: [event(2, "commandExecution", "omit secret"), event(3, "agentMessage", "last")], nextBeforeSeq: 2, throughSeq: 3 };
  } } as unknown as CoordinationService;
  const files = buildReferenceFiles(db, coordination, principal, parseReferences([{ id, version: "1:2:3" }]));
  const text = Buffer.from(files[0]!.data, "base64").toString();
  assert.ok(text.indexOf("first") < text.indexOf("last"));
  assert.doesNotMatch(text, /omit secret/);
  assert.match(text, /Partial/);
  assert.equal(files[0]!.name, `reference-1-${id}.md`);
});

test("rejects stale, cross-workspace and oversized references", () => {
  const db = { get: (_sql: string, sourceId: string, workspaceId: string) => sourceId === id && workspaceId === principal.workspaceId ? row : undefined } as unknown as ControlPlaneDatabase;
  const coordination = { historyPage: () => ({ items: [event(1, "userMessage", "x".repeat(4 * 1024 * 1024))], nextBeforeSeq: null, throughSeq: 3 }) } as unknown as CoordinationService;
  assert.throws(() => buildReferenceFiles(db, coordination, principal, [{ id, version: "1:2:2" }]), /changed/);
  assert.throws(() => buildReferenceFiles(db, coordination, { workspaceId: "other" } as Principal, [{ id, version: "1:2:3" }]), /unavailable/);
  assert.throws(() => buildReferenceFiles(db, coordination, principal, [{ id, version: "1:2:3" }]), /safe file limit/);
  assert.throws(() => parseReferences([{ id, version: "1:2:3" }, { id, version: "1:2:3" }]), /duplicate/);
});
