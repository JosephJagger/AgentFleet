import test from "node:test";
import assert from "node:assert/strict";
import { referenceInputs } from "../src/runtime.js";

test("referenced history is a searchable local path, not an eager Codex file mention", () => {
  const id = `ls_${"a".repeat(32)}`;
  const reference = { name: `reference-1-${id}.md`, path: `/project/.agentfleets/uploads/command/${id}.md` };
  const userFile = { name: "readme.md", path: "/project/.agentfleets/uploads/command/readme.md" };
  const result = referenceInputs("Check the deployment mentioned there", [reference, userFile]);
  assert.deepEqual(result.attachments, [userFile]);
  assert.match(result.prompt, /Search|search/);
  assert.match(result.prompt, /\/project\/\.agentfleets\/uploads\/command/);
  assert.match(result.prompt, /Check the deployment mentioned there/);
});
