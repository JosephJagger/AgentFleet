import test from "node:test";
import assert from "node:assert/strict";
import { parseAttachments, parsePlugins, parsePluginSkills } from "../src/attachments.js";

const safeXlsx = "UEsDBBQAAAAIAO9yMF3HHBc8CgAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbLMJqSxILda3AwBQSwMEFAAAAAgA73IwXYLZHNUSAAAAEAAAAAsAAABfcmVscy8ucmVsc7MJSs1JLMnMzyvOyCwo1rcDAFBLAwQUAAAACADvcjBdzp6YEw0AAAALAAAADwAAAHhsL3dvcmtib29rLnhtbLMpzy/KTsrPz9a3AwBQSwECFAMUAAAACADvcjBdxxwXPAoAAAAIAAAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAO9yMF2C2RzVEgAAABAAAAALAAAAAAAAAAAAAACAATsAAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAO9yMF3OnpgTDQAAAAsAAAAPAAAAAAAAAAAAAACAAXYAAAB4bC93b3JrYm9vay54bWxQSwUGAAAAAAMAAwC3AAAAsAAAAAAA";
const macroXlsx = "UEsDBBQAAAAIAPRyMF3HHBc8CgAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbLMJqSxILda3AwBQSwMEFAAAAAgA9HIwXYLZHNUSAAAAEAAAAAsAAABfcmVscy8ucmVsc7MJSs1JLMnMzyvOyCwo1rcDAFBLAwQUAAAACAD0cjBdzp6YEw0AAAALAAAADwAAAHhsL3dvcmtib29rLnhtbLMpzy/KTsrPz9a3AwBQSwMEFAAAAAgA9HIwXfs5K4IFAAAAAwAAABEAAAB4bC92YmFQcm9qZWN0LmJpbktKTAEAUEsBAhQDFAAAAAgA9HIwXcccFzwKAAAACAAAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACAD0cjBdgtkc1RIAAAAQAAAACwAAAAAAAAAAAAAAgAE7AAAAX3JlbHMvLnJlbHNQSwECFAMUAAAACAD0cjBdzp6YEw0AAAALAAAADwAAAAAAAAAAAAAAgAF2AAAAeGwvd29ya2Jvb2sueG1sUEsBAhQDFAAAAAgA9HIwXfs5K4IFAAAAAwAAABEAAAAAAAAAAAAAAIABsAAAAHhsL3ZiYVByb2plY3QuYmluUEsFBgAAAAAEAAQA9gAAAOQAAAAAAA==";

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

test("accepts whole-plugin references without exposing internal skills", () => {
  assert.deepEqual(parsePlugins([{ pluginId: "shopify@remote", pluginName: "Shopify" }]), [{ pluginId: "shopify@remote", pluginName: "Shopify" }]);
  assert.throws(() => parsePlugins([{ pluginId: "shopify@remote", pluginName: "" }]), /格式/);
});

test("rejects unsupported extensions and binary content before host materialization",()=>{
  const data=Buffer.from("hello").toString("base64");
  assert.throws(()=>parseAttachments([{name:"archive.zip",relativePath:"archive.zip",mimeType:"text/plain",data}]),/不支持/);
  assert.throws(()=>parseAttachments([{name:"binary.md",relativePath:"binary.md",mimeType:"text/markdown",data:Buffer.from([0,255]).toString("base64")}]),/UTF-8/);
});

test("accepts verified PDF and macro-free XLSX while rejecting renamed or active files", () => {
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n").toString("base64");
  assert.equal(parseAttachments([{ name: "manual.pdf", relativePath: "manual.pdf", mimeType: "application/pdf", data: pdf }]).length, 1);
  assert.equal(parseAttachments([{ name: "book.xlsx", relativePath: "book.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: safeXlsx }]).length, 1);
  assert.throws(() => parseAttachments([{ name: "fake.pdf", relativePath: "fake.pdf", mimeType: "application/pdf", data: Buffer.from("plain").toString("base64") }]), /格式/);
  assert.throws(() => parseAttachments([{ name: "macro.xlsx", relativePath: "macro.xlsx", mimeType: "application/octet-stream", data: macroXlsx }]), /格式/);
});
