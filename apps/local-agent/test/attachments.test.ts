import test from "node:test";
import assert from "node:assert/strict";
import { parseAttachments, parsePluginSkills } from "../src/attachments.js";

test("accepts bounded files and preserves folder paths", () => {
  const result = parseAttachments([{ name: "a.txt", relativePath: "docs/a.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") }]);
  assert.equal(result[0]?.relativePath, "docs/a.txt");
});

test("rejects traversal, duplicate paths, and malformed base64", () => {
  const file = { name: "a.txt", relativePath: "../a.txt", mimeType: "text/plain", data: "aGVsbG8=" };
  assert.throws(() => parseAttachments([file]), /路径/);
  assert.throws(() => parseAttachments([{ ...file, relativePath: "a.txt" }, { ...file, relativePath: "a.txt" }]), /重复/);
  assert.throws(() => parseAttachments([{ ...file, relativePath: "a.txt", data: "%%%" }]), /内容/);
});

test("only accepts bounded plugin skill references", () => {
  assert.deepEqual(parsePluginSkills([{ pluginId: "p", name: "skill", path: "/skills/skill/SKILL.md" }])[0]?.name, "skill");
  assert.throws(() => parsePluginSkills([{ pluginId: "p", name: "skill", path: "" }]), /格式/);
});
