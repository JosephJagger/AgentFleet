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

test("control plane accepts verified UTF-8 source and rejects renamed binary files", () => {
  assert.equal(parseAttachments([{name:"main.ts",relativePath:"src/main.ts",mimeType:"application/octet-stream",data:Buffer.from("export const ok = true;\n").toString("base64")}]).length,1);
  assert.throws(()=>parseAttachments([{name:"manual.pdf",relativePath:"manual.pdf",mimeType:"text/plain",data:Buffer.from("plain").toString("base64")}]),/不支持/);
  assert.throws(()=>parseAttachments([{name:"fake.txt",relativePath:"fake.txt",mimeType:"text/plain",data:Buffer.from([0,1,2]).toString("base64")}]),/UTF-8/);
});
