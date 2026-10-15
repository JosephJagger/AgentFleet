import type { ControlPlaneDatabase } from "./db.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";
import { nowIso } from "./crypto.js";

export const DEFAULT_TAKEOVER_IDLE_DAYS = 14;
export class TakeoverPolicy {
  constructor(private readonly db: ControlPlaneDatabase) {}
  read(workspaceId: string): { idleDays: number; revision: number } {
    const row = this.db.get<{ idle_days: number; revision: number }>(
      "SELECT idle_days,revision FROM takeover_policies WHERE workspace_id=?", workspaceId);
    return { idleDays: row?.idle_days ?? DEFAULT_TAKEOVER_IDLE_DAYS, revision: row?.revision ?? 0 };
  }
  save(principal: Principal, input: Record<string, unknown>) {
    invariant(Object.keys(input).every(key => key === "idleDays" || key === "revision") &&
      Number.isInteger(input.idleDays) && Number(input.idleDays) >= 1 && Number(input.idleDays) <= 30 &&
      Number.isSafeInteger(input.revision) && Number(input.revision) >= 0,
      400, "INVALID_TAKEOVER_POLICY", "闲置时长必须是 1 至 30 的整数天");
    return this.db.transaction(() => {
      const current = this.read(principal.workspaceId);
      invariant(current.revision === input.revision, 409, "SETTINGS_REVISION_CONFLICT", "设置已在其他浏览器修改，请重新读取后保存");
      this.db.run(`INSERT INTO takeover_policies(workspace_id,idle_days,revision,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(workspace_id) DO UPDATE SET idle_days=excluded.idle_days,revision=excluded.revision,updated_at=excluded.updated_at`,
        principal.workspaceId, Number(input.idleDays), current.revision + 1, nowIso());
      this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId, action: "takeover.policy.update",
        metadata: { idleDays: input.idleDays, previousIdleDays: current.idleDays, revision: current.revision + 1 } });
      return this.read(principal.workspaceId);
    });
  }
}
