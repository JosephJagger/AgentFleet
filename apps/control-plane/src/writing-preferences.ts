import type { ControlPlaneDatabase } from "./db.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";
export const writingDefaults = { terms: true, suggestions: true, nlp: true, learning: true };
export type WritingOptions = typeof writingDefaults;
export class WritingPreferences {
  constructor(private db: ControlPlaneDatabase) {}
  private session(principal: Principal, sessionId?: string) {
    if (sessionId) invariant(this.db.get("SELECT 1 FROM logical_sessions WHERE logical_session_id=? AND workspace_id=? AND deleted_at IS NULL",sessionId,principal.workspaceId),404,"SESSION_NOT_FOUND","Session not found");
  }
  effective(userId: string, sessionId?: string) {
    const global = this.db.get<{settings_json:string}>("SELECT settings_json FROM writing_defaults WHERE user_id=?", userId);
    const local = sessionId ? this.db.get<{settings_json:string}>("SELECT settings_json FROM writing_overrides WHERE user_id=? AND session_id=?",userId,sessionId) : undefined;
    const defaults: WritingOptions = {...writingDefaults,...(global ? JSON.parse(global.settings_json) : {})};
    const overrides: Partial<WritingOptions> | null = local ? JSON.parse(local.settings_json) : null;
    return { defaults, overrides, effective: {...defaults,...overrides} as WritingOptions };
  }
  read(principal: Principal, sessionId?: string) { this.session(principal,sessionId); return this.effective(principal.userId,sessionId); }
  save(principal: Principal, body: Record<string,unknown>, sessionId?: string) {
    this.session(principal,sessionId);
    if (sessionId && body.settings === null) this.db.run("DELETE FROM writing_overrides WHERE user_id=? AND session_id=?",principal.userId,sessionId);
    else {
      invariant(body.settings && typeof body.settings === "object" && !Array.isArray(body.settings),400,"INVALID_INPUT","Invalid writing settings");
      const input=body.settings as Record<string,unknown>;
      invariant(Object.keys(input).every(key=>Object.hasOwn(writingDefaults,key) && typeof input[key] === "boolean"),400,"INVALID_INPUT","Invalid writing option");
      if(sessionId) {
        const settings={...this.effective(principal.userId,sessionId).overrides,...input};
        this.db.run("INSERT INTO writing_overrides(user_id,session_id,settings_json) VALUES(?,?,?) ON CONFLICT(user_id,session_id) DO UPDATE SET settings_json=excluded.settings_json",principal.userId,sessionId,JSON.stringify(settings));
      } else {
        const settings={...this.effective(principal.userId).defaults,...input};
        this.db.run("INSERT INTO writing_defaults(user_id,settings_json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json",principal.userId,JSON.stringify(settings));
      }
    }
    return this.read(principal,sessionId);
  }
}
