import test from "node:test";
import assert from "node:assert/strict";
import { parseAttachments, parsePluginSkills } from "../src/attachments.js";

test("control plane validates file and plugin payloads before dispatch", () => {
  const file = { name: "readme.md", relativePath: "source/readme.md", mimeType: "text/markdown", data: Buffer.from("# title").toString("base64") };
  assert.equal(parseAttachments([file])[0]?.name, "readme.md");
  assert.equal(parsePluginSkills([{ pluginId: "plugin", name: "skill", path: "/plugin/SKILL.md" }])[0]?.pluginId, "plugin");
});

test("control plane rejects path traversal and empty plugin paths", () => {
  assert.throws(() => parseAttachments([{ name: "x", relativePath: "folder/../x", mimeType: "", data: "eA==" }]), /路径/);
  assert.throws(() => parsePluginSkills([{ pluginId: "plugin", name: "skill", path: "" }]), /格式/);
});
