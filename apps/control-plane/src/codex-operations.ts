export const CODEX_OPERATIONS = ["account.read", "account.login", "account.login.cancel", "account.logout", "usage.read", "resetCards.read", "resetCard.consume", "goal.set", "goal.clear", "plugin.install", "plugin.uninstall", "mcp.login", "mcp.reload", "skill.toggle", "provider.read", "attachments.read", "memory.status", "history.search", "timeline.read", "nativeQueue.read", "turn.settings", "config.requirements", "experiment.configure", "memory.mode", "memory.reset", "plugin.catalog", "plugin.reconcile", "marketplace.add", "marketplace.remove", "marketplace.upgrade", "goal.read", "apps.installed", "apps.read", "sections.read", "section.create", "section.rename", "section.delete", "section.move", "attachment.note", "attachment.remove", "nativeQueue.update", "nativeQueue.delete", "nativeQueue.reorder", "diagnostics.read", "workspaceMessages.read", "windows.readiness", "mcp.catalog", "mcp.resource", "mcp.call", "files.search", "files.list", "terminal.run"] as const;
export type CodexOperation = typeof CODEX_OPERATIONS[number];
export interface CodexOperationRequest { operation: CodexOperation; arguments: Record<string, unknown> }
export interface CodexOperationResult { operation: string; status: string; rows: { name: string; detail: string; status: string }[]; url?: string; nextCursor?: string }

export function parseCodexOperation(value: unknown): CodexOperationRequest {
  const fail = (): never => { throw new Error("Invalid Codex operation or arguments"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["operation", "arguments"].includes(key)) || !CODEX_OPERATIONS.includes(raw.operation as CodexOperation)) return fail();
  const args = raw.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return fail();
  const a = { ...args } as Record<string, unknown>;
  const fields: Record<CodexOperation, string[]> = { "account.read": [], "account.login": ["confirmed"], "account.login.cancel": ["loginId", "confirmed"], "account.logout": ["confirmed"], "usage.read": ["scope"], "resetCards.read": [], "resetCard.consume": ["creditId", "confirmed"], "goal.set": ["objective", "status", "tokenBudget"], "goal.clear": ["confirmed"], "plugin.install": ["pluginName", "remoteMarketplaceName", "confirmed"], "plugin.uninstall": ["pluginId", "confirmed"], "mcp.login": ["name"], "mcp.reload": ["confirmed"], "skill.toggle": ["name", "enabled", "confirmed"], "provider.read": [], "attachments.read": ["cursor"], "memory.status": ["experimental"], "history.search": ["searchTerm", "cursor", "experimental"], "timeline.read": ["cursor", "experimental"], "nativeQueue.read": ["cursor", "experimental"], "turn.settings": ["model", "effort", "serviceTier", "summary", "experimental", "confirmed"], "config.requirements": [], "experiment.configure": ["enabled", "confirmed", "experimental"], "memory.mode": ["enabled", "confirmed", "experimental"], "memory.reset": ["confirmed", "experimental"], "plugin.catalog": [], "plugin.reconcile": ["confirmed"], "marketplace.add": ["source", "confirmed"], "marketplace.remove": ["marketplaceName", "confirmed"], "marketplace.upgrade": ["marketplaceName", "confirmed"], "goal.read": [], "apps.installed": [], "apps.read": ["appId"], "sections.read": ["cursor"], "section.create": ["name", "confirmed"], "section.rename": ["sectionId", "name", "confirmed"], "section.delete": ["sectionId", "confirmed"], "section.move": ["sectionId", "confirmed"], "attachment.note": ["identityKey", "text", "confirmed"], "attachment.remove": ["identityKey", "confirmed"], "nativeQueue.update": ["submissionId", "text", "confirmed", "experimental"], "nativeQueue.delete": ["submissionId", "confirmed", "experimental"], "nativeQueue.reorder": ["submissionIds", "confirmed", "experimental"], "diagnostics.read": ["experimental"], "workspaceMessages.read": [], "windows.readiness": [], "mcp.catalog": ["name", "cursor"], "mcp.resource": ["name", "uri"], "mcp.call": ["name", "tool", "input", "confirmed"], "files.search": ["query"], "files.list": ["path", "cursor"], "terminal.run": ["argv", "confirmed"] };
  const op = raw.operation as CodexOperation;
  if (Object.keys(a).some(key => !fields[op].includes(key))) return fail();
  for (const key of ["loginId", "creditId", "objective", "pluginName", "pluginId", "remoteMarketplaceName", "name", "searchTerm", "cursor", "model", "effort", "marketplaceName", "source", "appId", "sectionId", "identityKey", "text", "submissionId", "uri", "tool", "query", "path"]) {
    if (a[key] !== undefined && !(key === "sectionId" && op === "section.move" && a[key] === null) && (typeof a[key] !== "string" || !a[key].trim() || a[key].length > (key === "text" ? 12000 : key === "uri" ? 2048 : key === "cursor" ? 4096 : key === "objective" ? 2000 : 256) || a[key].includes("\0"))) return fail();
  }
  if (["memory.status", "history.search", "timeline.read", "nativeQueue.read", "turn.settings", "experiment.configure", "memory.mode", "memory.reset"].includes(op) && a.experimental !== true) return fail();
  if (["experiment.configure", "memory.mode"].includes(op) && (typeof a.enabled !== "boolean" || a.confirmed !== true)) return fail();
  if (["memory.reset", "plugin.reconcile", "marketplace.add", "marketplace.remove", "marketplace.upgrade"].includes(op) && a.confirmed !== true) return fail();
  if (op === "marketplace.add" && (typeof a.source !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(a.source))) return fail();
  if (op === "marketplace.remove" && !a.marketplaceName) return fail();
  if (op === "history.search" && !a.searchTerm) return fail();
  if (op === "turn.settings" && (a.confirmed !== true || !["model", "effort", "serviceTier", "summary"].some(key => key in a) || a.serviceTier !== undefined && a.serviceTier !== null && !["fast", "flex"].includes(String(a.serviceTier)) || a.summary !== undefined && !["auto", "concise", "detailed", "none"].includes(String(a.summary)))) return fail();
  if (op === "usage.read" && a.scope !== undefined && !["account", "thread"].includes(String(a.scope))) return fail();
  if (op === "goal.set" && (Object.keys(a).length === 0 || a.status !== undefined && !["paused", "complete"].includes(String(a.status)) || a.tokenBudget !== undefined && a.tokenBudget !== null && (!Number.isSafeInteger(a.tokenBudget) || Number(a.tokenBudget) <= 0))) return fail();
  if (op === "goal.set" && a.status === undefined) a.status = "paused";
  if (op === "plugin.install" && (!a.pluginName || !a.remoteMarketplaceName) || op === "plugin.uninstall" && !a.pluginId || op === "mcp.login" && !a.name || op === "skill.toggle" && (!a.name || typeof a.enabled !== "boolean")) return fail();
  if (op === "account.login.cancel" && !a.loginId) return fail();
  if (["account.login", "account.login.cancel", "account.logout", "resetCard.consume", "goal.clear", "plugin.install", "plugin.uninstall", "mcp.reload", "skill.toggle"].includes(op) && a.confirmed !== true) return fail();
  if (["nativeQueue.update", "nativeQueue.delete", "nativeQueue.reorder", "diagnostics.read"].includes(op) && a.experimental !== true) return fail();
  if (["section.create", "section.rename", "section.delete", "section.move", "attachment.note", "attachment.remove", "nativeQueue.update", "nativeQueue.delete", "nativeQueue.reorder"].includes(op) && a.confirmed !== true) return fail();
  if (["section.create", "section.rename"].includes(op) && !a.name || ["section.rename", "section.delete"].includes(op) && !a.sectionId || op === "apps.read" && !a.appId) return fail();
  if (op === "section.move" && !("sectionId" in a)) return fail();
  if (op === "section.move" && a.sectionId !== null && (typeof a.sectionId !== "string" || !a.sectionId.trim())) return fail();
  if (["attachment.note", "attachment.remove"].includes(op) && !a.identityKey || ["attachment.note", "nativeQueue.update"].includes(op) && !a.text || ["nativeQueue.update", "nativeQueue.delete"].includes(op) && !a.submissionId) return fail();
  if (op === "nativeQueue.reorder" && (!Array.isArray(a.submissionIds) || a.submissionIds.length > 100 || new Set(a.submissionIds).size !== a.submissionIds.length || a.submissionIds.some(id => typeof id !== "string" || !id || id.length > 256 || id.includes("\0")))) return fail();
  if (["mcp.resource", "mcp.call"].includes(op) && !a.name || op === "mcp.resource" && !a.uri || op === "mcp.call" && (!a.tool || a.confirmed !== true)) return fail();
  if (op === "files.search" && !a.query) return fail();
  if (op === "files.list" && a.path !== undefined && (String(a.path).startsWith("/") || String(a.path).includes("\\") || /(?:^|\/)\.\.(?:\/|$)/.test(String(a.path)) || /^[A-Za-z]:/.test(String(a.path)))) return fail();
  if (op === "terminal.run" && (a.confirmed !== true || !Array.isArray(a.argv) || !a.argv.length || a.argv.length > 64 || a.argv.some(arg => typeof arg !== "string" || arg.length > 2000 || arg.includes("\0")) || typeof a.argv[0] !== "string" || !a.argv[0].trim() || new TextEncoder().encode(JSON.stringify(a.argv)).length > 16000)) return fail();
  if (op === "mcp.call") {
    if (a.input === undefined) a.input = {};
    let nodes = 0;
    const valid = (v: unknown, depth: number): boolean => {
      if (++nodes > 300 || depth > 8) return false;
      if (v === null || typeof v === "boolean") return true;
      if (typeof v === "string") return v.length <= 12000;
      if (typeof v === "number") return Number.isFinite(v);
      if (Array.isArray(v)) return v.every(item => valid(item, depth + 1));
      if (v && typeof v === "object") return Object.entries(v).every(([key, item]) => !["__proto__", "prototype", "constructor"].includes(key) && !/(?:password|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|authorization|credential)/i.test(key) && valid(item, depth + 1));
      return false;
    };
    if (!a.input || typeof a.input !== "object" || Array.isArray(a.input) || !valid(a.input, 0) || new TextEncoder().encode(JSON.stringify(a.input)).length > 16000) return fail();
  }
  return { operation: op, arguments: structuredClone(a) };
}

export function readOnlyCodexOperation(operation: string) { return ["account.read", "usage.read", "resetCards.read", "provider.read", "attachments.read", "memory.status", "history.search", "timeline.read", "nativeQueue.read", "config.requirements", "plugin.catalog", "goal.read", "apps.installed", "apps.read", "sections.read", "diagnostics.read", "workspaceMessages.read", "windows.readiness", "mcp.catalog", "mcp.resource", "files.search", "files.list"].includes(operation); }

export function liveCodexOperation(operation: string) { return ["turn.settings", "nativeQueue.update", "nativeQueue.delete", "nativeQueue.reorder"].includes(operation); }

export function parseForkRange(value: unknown): { beforeTurnId?: string; lastTurnId?: string } {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid fork range");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["beforeTurnId", "lastTurnId"].includes(key)) || "beforeTurnId" in v && "lastTurnId" in v) throw new Error("Invalid fork range");
  for (const id of Object.values(v)) if (typeof id !== "string" || !id.trim() || id.length > 256 || id.includes("\0")) throw new Error("Invalid fork range");
  return { ...v };
}

export function parseReviewTarget(value: unknown): Record<string, unknown> {
  if (value === undefined) return { type: "uncommittedChanges" };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid review target");
  const target = value as Record<string, unknown>;
  const fields: Record<string, string[]> = { uncommittedChanges: ["type"], baseBranch: ["type", "branch"], commit: ["type", "sha"], custom: ["type", "instructions"] };
  if (typeof target.type !== "string" || !fields[target.type] || Object.keys(target).some(key => !fields[String(target.type)]!.includes(key))) throw new Error("Invalid review target");
  const field = target.type === "baseBranch" ? "branch" : target.type === "commit" ? "sha" : target.type === "custom" ? "instructions" : null;
  if (field && (typeof target[field] !== "string" || !target[field].trim() || target[field].length > (field === "instructions" ? 4000 : 256) || target[field].includes("\0"))) throw new Error("Invalid review target");
  if (target.type === "commit" && !/^[a-fA-F0-9]{7,64}$/.test(String(target.sha))) throw new Error("Invalid commit SHA");
  return { ...target };
}

/** Same whitelist is applied again by the control plane before browser delivery. */
export function sanitizeCodexResult(value: unknown): CodexOperationResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!CODEX_OPERATIONS.includes(v.operation as CodexOperation) || typeof v.status !== "string") return null;
  const rows = Array.isArray(v.rows) ? v.rows.slice(0, 50).map(row => {
    const r = row && typeof row === "object" ? row as Record<string, unknown> : {};
    return { name: typeof r.name === "string" ? r.name.slice(0, 256) : "", detail: typeof r.detail === "string" ? r.detail.slice(0, 1200) : "", status: typeof r.status === "string" ? r.status.slice(0, 200) : "" };
  }) : [];
  let url: string | undefined;
  if (typeof v.url === "string") {
    try { const u = new URL(v.url); if (u.protocol === "https:" && !u.username && !u.password && v.url.length <= 4096) url = v.url; } catch { /* Invalid OAuth URL is never clickable. */ }
  }
  return { operation: String(v.operation), status: v.status.slice(0, 200), rows, ...(url ? { url } : {}), ...(typeof v.nextCursor === "string" && v.nextCursor.length <= 4096 ? { nextCursor: v.nextCursor } : {}) };
}
