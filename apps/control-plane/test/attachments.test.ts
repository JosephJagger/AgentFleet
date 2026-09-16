import test from "node:test";
import assert from "node:assert/strict";
import { parseAttachments, parsePlugins, parsePluginSkills } from "../src/attachments.js";

const safeXlsx = "UEsDBBQAAAAIAO9yMF3HHBc8CgAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbLMJqSxILda3AwBQSwMEFAAAAAgA73IwXYLZHNUSAAAAEAAAAAsAAABfcmVscy8ucmVsc7MJSs1JLMnMzyvOyCwo1rcDAFBLAwQUAAAACADvcjBdzp6YEw0AAAALAAAADwAAAHhsL3dvcmtib29rLnhtbLMpzy/KTsrPz9a3AwBQSwECFAMUAAAACADvcjBdxxwXPAoAAAAIAAAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAO9yMF2C2RzVEgAAABAAAAALAAAAAAAAAAAAAACAATsAAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAO9yMF3OnpgTDQAAAAsAAAAPAAAAAAAAAAAAAACAAXYAAAB4bC93b3JrYm9vay54bWxQSwUGAAAAAAMAAwC3AAAAsAAAAAAA";

test("control plane validates file and plugin payloads before dispatch", () => {
  const file = { name: "readme.md", relativePath: "source/readme.md", mimeType: "text/markdown", data: Buffer.from("# title").toString("base64") };
  assert.equal(parseAttachments([file])[0]?.name, "readme.md");
  assert.equal(parsePluginSkills([{ pluginId: "plugin", name: "skill", path: "/plugin/SKILL.md" }])[0]?.pluginId, "plugin");
  assert.deepEqual(parsePlugins([{ pluginId: "shopify@remote", pluginName: "Shopify" }])[0], { pluginId: "shopify@remote", pluginName: "Shopify" });
});

test("control plane rejects path traversal and empty plugin paths", () => {
  assert.throws(() => parseAttachments([{ name: "x", relativePath: "folder/../x", mimeType: "", data: "eA==" }]), /路径/);
  assert.throws(() => parsePluginSkills([{ pluginId: "plugin", name: "skill", path: "" }]), /格式/);
  assert.throws(() => parsePlugins([{ pluginId: "plugin", pluginName: "" }]), /格式/);
});

test("control plane accepts verified UTF-8 source and rejects renamed binary files", () => {
  assert.equal(parseAttachments([{name:"main.ts",relativePath:"src/main.ts",mimeType:"application/octet-stream",data:Buffer.from("export const ok = true;\n").toString("base64")}]).length,1);
  assert.throws(()=>parseAttachments([{name:"manual.pdf",relativePath:"manual.pdf",mimeType:"text/plain",data:Buffer.from("plain").toString("base64")}]),/格式/);
  assert.throws(()=>parseAttachments([{name:"fake.txt",relativePath:"fake.txt",mimeType:"text/plain",data:Buffer.from([0,1,2]).toString("base64")}]),/UTF-8/);
});

test("control plane accepts structurally verified PDF and XLSX files", () => {
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n").toString("base64");
  assert.equal(parseAttachments([{name:"manual.pdf",relativePath:"manual.pdf",mimeType:"application/pdf",data:pdf}]).length, 1);
  assert.equal(parseAttachments([{name:"book.xlsx",relativePath:"book.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",data:safeXlsx}]).length, 1);
  assert.throws(()=>parseAttachments([{name:"book.xlsx",relativePath:"book.xlsx",mimeType:"application/octet-stream",data:Buffer.from("PK fake").toString("base64")}]),/格式/);
});
