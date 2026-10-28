import { describe, expect, it, vi } from "vitest";
import english from "../i18n/en.json";
import { CODEX_ROW_LABEL_RULES, codexOperationRowText } from "./codex-operation-rows";

vi.mock("../i18n", () => ({
  t: (source: string, ...values: unknown[]) => `«${source.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)]))}»`,
}));

describe("Codex result row localization boundaries", () => {
  it("keeps every approved dynamic UI label in the source catalog", () => {
    const missing = [...new Set(CODEX_ROW_LABEL_RULES.flatMap(rule => rule.labels))].filter(label => !Object.hasOwn(english, label));
    expect(missing).toEqual([]);
  });

  it("translates application fields without touching account or native values", () => {
    const row = { name: "认证方式", detail: "保存", status: "计划模式" };
    expect(codexOperationRowText("account.read", row, "name")).toBe("«认证方式»");
    expect(codexOperationRowText("account.read", row, "detail")).toBe("保存");
    expect(codexOperationRowText("account.read", row, "status")).toBe("计划模式");
  });

  it.each(["sections.read", "plugin.catalog", "mcp.catalog", "apps.installed"])("preserves names matching UI labels in %s", operation => {
    const row = { name: "保存", detail: "用户原文：保存", status: "计划模式" };
    expect(codexOperationRowText(operation, row, "name")).toBe("保存");
    expect(codexOperationRowText(operation, row, "detail")).toBe(row.detail);
    expect(codexOperationRowText(operation, row, "status")).toBe("计划模式");
  });

  it("distinguishes official usage statistics from native model names", () => {
    const summary = { name: "官方累计 tokens", detail: "1200", status: "官方上报" };
    expect(codexOperationRowText("usage.read", summary, "name")).toBe("«官方累计 tokens»");
    expect(codexOperationRowText("usage.read", summary, "status")).toBe("«官方上报»");
    expect(codexOperationRowText("usage.read", { ...summary, status: "此会话" }, "name")).toBe(summary.name);
  });

  it("preserves goal objectives and native states while translating metric labels", () => {
    const goal = { name: "目标", detail: "未设置", status: "原生目标统计" };
    expect(codexOperationRowText("goal.read", goal, "name")).toBe("«目标»");
    expect(codexOperationRowText("goal.read", goal, "detail")).toBe("未设置");
    expect(codexOperationRowText("goal.read", goal, "status")).toBe("原生目标统计");
    const metric = { ...goal, name: "tokenBudget" };
    expect(codexOperationRowText("goal.read", metric, "name")).toBe("tokenBudget");
    expect(codexOperationRowText("goal.read", metric, "detail")).toBe("«未设置»");
    expect(codexOperationRowText("goal.read", metric, "status")).toBe("«原生目标统计»");
  });

  it("distinguishes the card count header from raw native card titles", () => {
    const row = { name: "可用重置卡", detail: "2", status: "详情已读取" };
    expect(codexOperationRowText("resetCards.read", row, "name")).toBe("«可用重置卡»");
    expect(codexOperationRowText("resetCards.read", { ...row, status: "可用" }, "name")).toBe(row.name);
    expect(codexOperationRowText("resetCards.read", { ...row, name: "保存", status: "可用" }, "name")).toBe("保存");
  });

  it("does not translate ambiguous native search and MCP metadata", () => {
    expect(codexOperationRowText("plugin.search", { name: "插件", detail: "描述", status: "已安装" }, "status")).toBe("已安装");
    expect(codexOperationRowText("mcp.catalog", { name: "保存", detail: "请指定 MCP 名称缩小范围", status: "MCP 工具" }, "detail")).toBe("请指定 MCP 名称缩小范围");
  });

  it("localizes generated usage counters and preserves counter values", () => {
    const row = { name: "gpt-model", detail: "输入 123 · 缓存 未上报 · 输出 0", status: "此会话" };
    expect(codexOperationRowText("usage.read", row, "detail")).toBe("«输入 123 · 缓存 «未上报» · 输出 0»");
    expect(codexOperationRowText("usage.read", { ...row, status: "官方上报" }, "detail")).toBe(row.detail);
    expect(codexOperationRowText("usage.read", { ...row, detail: row.detail + "\n用户原文" }, "detail")).toBe(row.detail + "\n用户原文");
    expect(codexOperationRowText("mcp.call", row, "detail")).toBe(row.detail);
    expect(codexOperationRowText("history.search", row, "detail")).toBe(row.detail);
  });

  it("localizes generated reset-card fields while preserving UTC, Beijing time and card ID", () => {
    const row = { name: "保存", status: "可用", detail: "失效日期：2026-11-02 00:46:44 UTC\n卡片 ID：保存 / card-123" };
    expect(codexOperationRowText("resetCards.read", row, "detail")).toBe("«失效日期：2026-11-02 00:46:44 UTC»\n«北京时间（UTC+8）»：2026-11-02 08:46:44\n«卡片 ID：保存 / card-123»");
    expect(codexOperationRowText("resetCards.read", row, "name")).toBe("保存");
  });

  it.each(["不过期（原生注明）", "未返回有效期"])("localizes an explicit reset-card expiry state: %s", expiry => {
    const row = { name: "Card", status: "可用", detail: `失效日期：${expiry}` };
    expect(codexOperationRowText("resetCards.read", row, "detail")).toBe(`«失效日期：«${expiry}»»`);
  });

  it("leaves unsupported receipt formats and unrelated output untouched", () => {
    const row = { name: "Card", status: "可用", detail: "失效日期：未返回有效期\n这是工具输出" };
    expect(codexOperationRowText("resetCards.read", row, "detail")).toBe(row.detail);
    const known = { ...row, detail: "失效日期：未返回有效期\n卡片 ID：id" };
    expect(codexOperationRowText("mcp.call", known, "detail")).toBe(known.detail);
    expect(codexOperationRowText("resetCards.read", { ...known, status: "详情未上报" }, "detail")).toBe(known.detail);
  });
});
