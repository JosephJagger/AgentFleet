import { t } from "../i18n";
import { resetCardDetail } from "./reset-card-time";

type RowField = "name" | "status" | "detail";
type Row = { name: string; detail: string; status?: string };
interface LabelRule {
  operations: readonly string[];
  field: RowField;
  labels: readonly string[];
  when?: { field: RowField; values: readonly string[] };
}

// Only producer-owned labels belong here. A native name, model, title or output
// can match any catalog key; matching its text alone must never translate it.
// Mixed rows need a producer-owned discriminator, such as the usage row status.
export const CODEX_ROW_LABEL_RULES: readonly LabelRule[] = [
  {"operations": ["account.read"], "field": "name", "labels": ["认证方式"]},
  {"operations": ["account.login"], "field": "name", "labels": ["一次性登录码", "登录请求 ID"]},
  {"operations": ["account.login"], "field": "status", "labels": ["在官方授权页面输入", "可用于取消此次登录"]},
  {"operations": ["gateway.read", "remote.status"], "field": "status", "labels": ["原生状态"]},
  {"operations": ["voice.catalog"], "field": "status", "labels": ["原生目录；不代表当前 v3 通话的可用性验证"]},
  {"operations": ["windows.readiness"], "field": "name", "labels": ["Windows 原生沙箱"]},
  {"operations": ["windows.readiness"], "field": "status", "labels": ["原生状态；未执行安装"]},
  {"operations": ["workspaceMessages.read"], "field": "status", "labels": ["发布时间未上报"]},
  {"operations": ["goal.read"], "field": "name", "labels": ["目标"]},
  {"operations": ["goal.read"], "field": "status", "labels": ["原生目标统计"], "when": {"field": "name", "values": ["tokenBudget", "tokensUsed", "timeUsedSeconds"]}},
  {"operations": ["goal.read"], "field": "detail", "labels": ["未设置"], "when": {"field": "name", "values": ["tokenBudget", "tokensUsed", "timeUsedSeconds"]}},
  {"operations": ["apps.installed"], "field": "status", "labels": ["可以调用", "已启用；暂不可调用", "未启用"]},
  {"operations": ["apps.read"], "field": "status", "labels": ["原生应用信息", "应用工具说明"]},
  {"operations": ["diagnostics.read"], "field": "status", "labels": ["当前原生进程", "原生诊断"]},
  {"operations": ["diagnostics.read"], "field": "detail", "labels": ["未上报"]},
  {"operations": ["sections.read", "section.create", "section.rename", "section.delete", "section.move"], "field": "status", "labels": ["原生分组"]},
  {"operations": ["attachment.note", "attachment.remove"], "field": "name", "labels": ["原生会话备注"]},
  {"operations": ["attachment.note", "attachment.remove"], "field": "status", "labels": ["保存为会话元数据；不会自动作为下一轮输入"]},
  {"operations": ["usage.read"], "field": "status", "labels": ["官方上报", "每日用量", "官方估算", "此会话"]},
  {"operations": ["usage.read"], "field": "name", "labels": ["官方累计 tokens", "连续使用天数", "最长连续使用天数", "单日最高 tokens", "最长任务秒数"], "when": {"field": "status", "values": ["官方上报"]}},
  {"operations": ["usage.read"], "field": "name", "labels": ["此会话估算点数"], "when": {"field": "status", "values": ["官方估算"]}},
  {"operations": ["plugin.catalog"], "field": "status", "labels": ["已安装", "可安装", "结果不完整"]},
  {"operations": ["plugin.catalog"], "field": "name", "labels": ["部分插件来源读取失败"], "when": {"field": "status", "values": ["结果不完整"]}},
  {"operations": ["plugin.reconcile"], "field": "name", "labels": ["未完成的插件数"]},
  {"operations": ["plugin.reconcile"], "field": "status", "labels": ["原生同步结果"]},
  {"operations": ["marketplace.add", "marketplace.remove", "marketplace.upgrade"], "field": "name", "labels": ["插件市场"]},
  {"operations": ["marketplace.add", "marketplace.remove", "marketplace.upgrade"], "field": "status", "labels": ["已存在；未重复添加", "主机已完成"]},
  {"operations": ["config.read"], "field": "status", "labels": ["用户配置版本"], "when": {"field": "name", "values": ["version"]}},
  {"operations": ["config.requirements"], "field": "status", "labels": ["原生管理策略；面板不绕过此限制"]},
  {"operations": ["experiment.configure"], "field": "status", "labels": ["重新连接 Codex 后生效；不改变运行中任务"]},
  {"operations": ["experiment.configure"], "field": "detail", "labels": ["启用", "停用"]},
  {"operations": ["turn.settings"], "field": "name", "labels": ["设置范围"]},
  {"operations": ["turn.settings"], "field": "status", "labels": ["实验能力"]},
  {"operations": ["turn.settings"], "field": "detail", "labels": ["仅本轮后续步骤；已开始的步骤、子会话和下一轮设置不受影响。不能切换计划模式。"]},
  {"operations": ["provider.read"], "field": "status", "labels": ["当前模型提供方"]},
  {"operations": ["provider.read"], "field": "detail", "labels": ["支持", "不支持", "未上报"]},
  {"operations": ["memory.status"], "field": "name", "labels": ["记忆已就绪", "已整合会话数"]},
  {"operations": ["memory.status"], "field": "status", "labels": ["实验能力"]},
  {"operations": ["attachments.read"], "field": "status", "labels": ["原生持久附件；仅显示面板备注内容"]},
  {"operations": ["nativeQueue.read"], "field": "status", "labels": ["原生队列；与面板排队任务分开"]},
  {"operations": ["resetCards.read"], "field": "name", "labels": ["可用重置卡"], "when": {"field": "status", "values": ["详情已读取", "详情未上报"]}},
  {"operations": ["resetCards.read"], "field": "status", "labels": ["详情已读取", "详情未上报", "可用", "使用中", "已使用", "状态未知"]},
  {"operations": ["mcp.login"], "field": "name", "labels": ["MCP 服务器"]},
  {"operations": ["mcp.login"], "field": "status", "labels": ["完成官方授权后，重新读取 MCP 清单确认状态"]},
  {"operations": ["mcp.resource"], "field": "status", "labels": ["原生资源返回"]},
  {"operations": ["mcp.call"], "field": "status", "labels": ["原生工具返回"]},
  {"operations": ["subagents.history"], "field": "name", "labels": ["任务", "回复"]},
];

const cardStatuses = ["可用", "使用中", "已使用", "状态未知"];

function usageDetail(row: Row): string {
  if (row.status !== "此会话") return row.detail;
  const match = /^输入 (未上报|\d+) · 缓存 (未上报|\d+) · 输出 (未上报|\d+)$/.exec(row.detail);
  if (!match) return row.detail;
  return t("输入 {0} · 缓存 {1} · 输出 {2}", ...match.slice(1).map(value => value === "未上报" ? t("未上报") : value));
}

function cardDetail(row: Row): string {
  if (!cardStatuses.includes(row.status ?? "")) return row.detail;
  const lines = row.detail.split("\n");
  const match = /^失效日期：(不过期（原生注明）|未返回有效期|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC)$/.exec(lines[0] ?? "");
  if (!match || lines.length > 2 || (lines.length === 2 && !/^卡片 ID：[^\r\n]*$/.test(lines[1]!))) return row.detail;
  const expiry = match[1] === "不过期（原生注明）" ? t("不过期（原生注明）") : match[1] === "未返回有效期" ? t("未返回有效期") : match[1]!;
  const expanded = resetCardDetail(row.detail, t("北京时间（UTC+8）")).split("\n");
  return expanded.map((line, index) => index === 0 ? t("失效日期：{0}", expiry) : line.startsWith("卡片 ID：") ? t("卡片 ID：{0}", line.slice("卡片 ID：".length)) : line).join("\n");
}

export function codexOperationRowText(operation: string, row: Row, field: RowField): string {
  const value = row[field];
  if (!value) return value ?? "";
  if (field === "detail" && operation === "usage.read") return usageDetail(row);
  if (field === "detail" && operation === "resetCards.read") return cardDetail(row);
  const owned = CODEX_ROW_LABEL_RULES.some(rule => rule.field === field && rule.operations.includes(operation) && rule.labels.includes(value)
    && (!rule.when || rule.when.values.includes(row[rule.when.field] ?? "")));
  return owned ? t(value) : value;
}
