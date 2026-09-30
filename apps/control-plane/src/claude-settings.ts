export type ClaudePermissionMode = "default"|"auto"|"acceptEdits"|"dontAsk";
export interface ClaudeSettings {model:string;effort?:string;mode?:"default"|"plan";permissionMode?:ClaudePermissionMode;}
export function parseClaudeSettings(value: unknown): ClaudeSettings | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Claude Code settings");
  const raw=value as Record<string,unknown>;
  if (Object.keys(raw).some(key=>!["model","effort","mode","permissionMode"].includes(key)) || typeof raw.model !== "string" || !/^(host|sonnet|opus|haiku|claude-[a-zA-Z0-9.-]{1,120})$/.test(raw.model) || (raw.effort !== undefined && !["low","medium","high","xhigh","max"].includes(String(raw.effort))) || (raw.mode !== undefined && !["default","plan"].includes(String(raw.mode)))) throw new Error("Unsupported Claude Code settings");
  if(raw.permissionMode !== undefined && !["default","auto","acceptEdits","dontAsk"].includes(String(raw.permissionMode)))throw new Error("Unsupported Claude permission mode");
  return {model:raw.model,...(raw.permissionMode ? {permissionMode:raw.permissionMode as ClaudePermissionMode} : {}),...(raw.effort ? {effort:String(raw.effort)} : {}),...(raw.mode ? {mode:raw.mode as "default"|"plan"} : {})};
}

export function supportsClaudeControls(version?:string,minimumPatch=57):boolean {
  const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if(!match)return false;
  const [major,minor,patch]=match.slice(1).map(Number);
  return major!>0 || minor!>30 || (minor===30 && patch!>=minimumPatch);
}
