export const CODEX_OPERATIONS = ["bedrock.discover", "bedrock.setup", "subagents.history", "experiments.read", "experiments.save", "migration.detect", "migration.import", "migration.history", "windows.setup", "skills.roots.read", "skills.roots.save", "gateway.read", "remote.status", "voice.catalog", "plugin.search", "history.turns", "subagents.read", "terminal.start", "terminal.status", "terminal.write", "terminal.stop", "terminal.resize", "config.read", "config.save", "files.trash", "files.restore", "files.read", "files.write", "files.create", "files.mkdir", "files.copy", "files.remove", "account.read", "account.login", "account.login.cancel", "account.logout", "usage.read", "resetCards.read", "resetCard.consume", "goal.set", "goal.clear", "plugin.install", "plugin.uninstall", "mcp.login", "mcp.reload", "skill.toggle", "provider.read", "attachments.read", "memory.status", "history.search", "timeline.read", "nativeQueue.read", "turn.settings", "config.requirements", "experiment.configure", "memory.mode", "memory.reset", "plugin.catalog", "plugin.reconcile", "marketplace.add", "marketplace.remove", "marketplace.upgrade", "goal.read", "apps.installed", "apps.read", "sections.read", "section.create", "section.rename", "section.delete", "section.move", "attachment.note", "attachment.remove", "nativeQueue.update", "nativeQueue.delete", "nativeQueue.reorder", "diagnostics.read", "workspaceMessages.read", "windows.readiness", "mcp.catalog", "mcp.resource", "mcp.call", "files.search", "files.list", "terminal.run"] as const;
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
  const fields: Record<CodexOperation, string[]> = { "bedrock.discover": [], "bedrock.setup": ["profile", "region", "confirmed"], "experiments.read": ["cursor"], "experiments.save": ["name", "enabled", "version", "confirmed"], "migration.detect": [], "migration.import": ["itemIds", "confirmed"], "migration.history": [], "windows.setup": ["mode", "confirmed"], "skills.roots.read": [], "skills.roots.save": ["roots", "version", "confirmed"], "gateway.read": [], "remote.status": [], "voice.catalog": ["experimental"], "plugin.search": ["searchTerm", "cursor", "experimental"], "history.turns": ["cursor"], "subagents.history": ["threadId", "cursor"], "subagents.read": ["cursor"], "terminal.start": ["command", "confirmed"], "terminal.status": ["processId"], "terminal.write": ["processId", "text", "confirmed"], "terminal.stop": ["processId", "confirmed"], "terminal.resize": ["processId", "rows", "cols", "confirmed"], "config.read": [], "config.save": ["version", "summary", "verbosity", "confirmed"], "files.trash": [], "files.restore": ["backup", "destination", "confirmed"], "files.read": ["path"], "files.write": ["path", "text", "revision", "confirmed"], "files.create": ["path", "text", "confirmed"], "files.mkdir": ["path", "confirmed"], "files.copy": ["path", "revision", "destination", "confirmed"], "files.remove": ["path", "revision", "confirmed"],  "account.read": [], "account.login": ["confirmed"], "account.login.cancel": ["loginId", "confirmed"], "account.logout": ["confirmed"], "usage.read": ["scope"], "resetCards.read": [], "resetCard.consume": ["creditId", "confirmed"], "goal.set": ["objective", "status", "tokenBudget"], "goal.clear": ["confirmed"], "plugin.install": ["pluginName", "remoteMarketplaceName", "confirmed"], "plugin.uninstall": ["pluginId", "confirmed"], "mcp.login": ["name"], "mcp.reload": ["confirmed"], "skill.toggle": ["name", "enabled", "confirmed"], "provider.read": [], "attachments.read": ["cursor"], "memory.status": ["experimental"], "history.search": ["searchTerm", "cursor", "experimental"], "timeline.read": ["cursor", "experimental"], "nativeQueue.read": ["cursor", "experimental"], "turn.settings": ["model", "effort", "serviceTier", "summary", "experimental", "confirmed"], "config.requirements": [], "experiment.configure": ["enabled", "confirmed", "experimental"], "memory.mode": ["enabled", "confirmed", "experimental"], "memory.reset": ["confirmed", "experimental"], "plugin.catalog": [], "plugin.reconcile": ["confirmed"], "marketplace.add": ["source", "confirmed"], "marketplace.remove": ["marketplaceName", "confirmed"], "marketplace.upgrade": ["marketplaceName", "confirmed"], "goal.read": [], "apps.installed": [], "apps.read": ["appId"], "sections.read": ["cursor"], "section.create": ["name", "confirmed"], "section.rename": ["sectionId", "name", "confirmed"], "section.delete": ["sectionId", "confirmed"], "section.move": ["sectionId", "confirmed"], "attachment.note": ["identityKey", "text", "confirmed"], "attachment.remove": ["identityKey", "confirmed"], "nativeQueue.update": ["submissionId", "text", "confirmed", "experimental"], "nativeQueue.delete": ["submissionId", "confirmed", "experimental"], "nativeQueue.reorder": ["submissionIds", "confirmed", "experimental"], "diagnostics.read": ["experimental"], "workspaceMessages.read": [], "windows.readiness": [], "mcp.catalog": ["name", "cursor"], "mcp.resource": ["name", "uri"], "mcp.call": ["name", "tool", "input", "confirmed"], "files.search": ["query"], "files.list": ["path", "cursor"], "terminal.run": ["argv", "confirmed"] };
  const op = raw.operation as CodexOperation;
  if (Object.keys(a).some(key => !fields[op].includes(key))) return fail();
  for (const key of ["loginId", "creditId", "objective", "pluginName", "pluginId", "remoteMarketplaceName", "name", "searchTerm", "cursor", "model", "effort", "marketplaceName", "source", "appId", "sectionId", "identityKey", "text", "submissionId", "uri", "tool", "query", "path"]) {
    if (a[key] !== undefined && !(key === "sectionId" && op === "section.move" && a[key] === null) && (typeof a[key] !== "string" || (!a[key].trim() && !(key === "text" && (op.startsWith("files.") || op === "terminal.write"))) || a[key].length > (key === "text" ? (op.startsWith("files.") ? 48000 : 12000) : key === "uri" ? 2048 : key === "cursor" ? 4096 : key === "objective" ? 2000 : 256) || a[key].includes("\0"))) return fail();
  }
  if (["memory.status", "history.search", "timeline.read", "nativeQueue.read", "turn.settings", "experiment.configure", "memory.mode", "memory.reset"].includes(op) && a.experimental !== true) return fail();
  if (["experiment.configure", "memory.mode"].includes(op) && (typeof a.enabled !== "boolean" || a.confirmed !== true)) return fail();
  if (["memory.reset", "plugin.reconcile", "marketplace.add", "marketplace.remove", "marketplace.upgrade"].includes(op) && a.confirmed !== true) return fail();
  if (op === "marketplace.add" && (typeof a.source !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(a.source))) return fail();
  if (op === "marketplace.remove" && !a.marketplaceName) return fail();
  if (["voice.catalog", "plugin.search"].includes(op) && a.experimental !== true) return fail();
  if (["history.search", "plugin.search"].includes(op) && !a.searchTerm) return fail();
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
  if (["files.read", "files.write", "files.create", "files.mkdir", "files.copy", "files.remove"].includes(op)) {
    if (typeof a.path !== "string" || !a.path.trim()) return fail();
    if (op !== "files.read" && a.confirmed !== true) return fail();
    if (["files.write", "files.create"].includes(op) && (typeof a.text !== "string" || new TextEncoder().encode(a.text).length > 48000)) return fail();
    if (["files.write", "files.copy", "files.remove"].includes(op) && (typeof a.revision !== "string" || !/^[a-f0-9]{64}$/.test(a.revision))) return fail();
    if (op === "files.copy" && (typeof a.destination !== "string" || !a.destination.trim() || a.destination.length > 256 || a.destination.includes("\0"))) return fail();
  }
  if (op === "terminal.start" && (a.confirmed !== true || typeof a.command !== "string" || !a.command.trim() || a.command.length > 4000 || a.command.includes("\0"))) return fail();
  if (["terminal.status", "terminal.write", "terminal.stop", "terminal.resize"].includes(op) && (typeof a.processId !== "string" || !/^[a-f0-9-]{36}$/.test(a.processId) || op !== "terminal.status" && a.confirmed !== true)) return fail();
  if (op === "terminal.write" && (typeof a.text !== "string" || a.text.length > 4000)) return fail();
  if (op === "terminal.resize" && (![a.rows, a.cols].every(v => Number.isInteger(v) && Number(v) >= 10 && Number(v) <= 300))) return fail();
  if (op === "bedrock.setup" && (a.confirmed !== true || typeof a.profile !== "string" || !a.profile.trim() || a.profile.length > 256 || a.profile.includes("\0") || typeof a.region !== "string" || !/^[a-z]{2}(?:-[a-z]+){1,3}-[0-9]+$/.test(a.region))) return fail();
  if (op === "experiments.save" && (a.confirmed !== true || typeof a.name !== "string" || !/^[a-z][a-z0-9_]{0,100}$/.test(a.name) || typeof a.enabled !== "boolean" || typeof a.version !== "string" || !a.version || a.version.length > 256)) return fail();
  if (op === "migration.import" && (a.confirmed !== true || !Array.isArray(a.itemIds) || !a.itemIds.length || a.itemIds.length > 40 || new Set(a.itemIds).size !== a.itemIds.length || a.itemIds.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)))) return fail();
  if (op === "windows.setup" && (a.confirmed !== true || !["elevated", "unelevated"].includes(String(a.mode)))) return fail();
  if (op === "skills.roots.save" && (a.confirmed !== true || typeof a.version !== "string" || !/^[a-f0-9]{64}$/.test(a.version) || !Array.isArray(a.roots) || a.roots.length > 16 || a.roots.some(p => typeof p !== "string" || !p.trim() || p.length > 1024 || p.includes("\0")))) return fail();
  if (op === "config.save" && (a.confirmed !== true || typeof a.version !== "string" || !a.version || a.version.length > 256 || !["auto", "concise", "detailed", "none"].includes(String(a.summary)) || !["low", "medium", "high"].includes(String(a.verbosity)))) return fail();
  if (op === "files.restore" && (a.confirmed !== true || typeof a.backup !== "string" || !/^\d+-[a-f0-9-]{36}-.{1,200}$/.test(a.backup) || /[\\/]/.test(a.backup) || typeof a.destination !== "string" || !a.destination.trim() || a.destination.length > 256 || a.destination.includes("\0"))) return fail();
  if (op === "subagents.history" && (typeof a.threadId !== "string" || !a.threadId || a.threadId.length > 256 || a.threadId.includes("\0"))) return fail();
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

export function readOnlyCodexOperation(operation: string) { return ["bedrock.discover", "subagents.history", "experiments.read", "migration.detect", "migration.history", "skills.roots.read", "gateway.read", "remote.status", "voice.catalog", "plugin.search", "history.turns", "subagents.read", "terminal.status", "config.read", "files.trash", "files.read", "account.read", "usage.read", "resetCards.read", "provider.read", "attachments.read", "memory.status", "history.search", "timeline.read", "nativeQueue.read", "config.requirements", "plugin.catalog", "goal.read", "apps.installed", "apps.read", "sections.read", "diagnostics.read", "workspaceMessages.read", "windows.readiness", "mcp.catalog", "mcp.resource", "files.search", "files.list"].includes(operation); }

export function liveCodexOperation(operation: string) { return ["terminal.write", "terminal.stop", "terminal.resize", "turn.settings", "nativeQueue.update", "nativeQueue.delete", "nativeQueue.reorder"].includes(operation); }

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

/** Operations whose native RPC does not require a project or thread. */
export const HOST_CODEX_OPERATIONS: readonly string[] = ["bedrock.discover", "bedrock.setup", "experiments.read", "experiments.save", "migration.detect", "migration.import", "migration.history", "windows.setup", "skills.roots.read", "skills.roots.save", "gateway.read", "remote.status", "voice.catalog", "plugin.search", "config.read", "config.save", "account.read", "account.login", "account.login.cancel", "account.logout", "usage.read", "resetCards.read", "resetCard.consume", "plugin.catalog", "plugin.install", "plugin.uninstall", "plugin.reconcile", "marketplace.add", "marketplace.remove", "marketplace.upgrade", "apps.installed", "apps.read", "config.requirements", "provider.read", "workspaceMessages.read", "windows.readiness", "memory.status", "memory.reset", "experiment.configure", "mcp.login", "mcp.reload", "skill.toggle"];
export function parseHostCodexOperation(value: unknown) {
  const request = parseCodexOperation(value);
  if (!HOST_CODEX_OPERATIONS.includes(request.operation) || request.operation === "usage.read" && request.arguments.scope === "thread") throw new Error("This operation requires a session context");
  return request;
}
