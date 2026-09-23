import type { AuthService, Principal } from "./auth.js";
import type { ControlPlaneDatabase } from "./db.js";
import { invariant } from "./errors.js";
import { nowIso } from "./crypto.js";

export class AdministrationService {
  constructor(private db: ControlPlaneDatabase, private auth: AuthService) {}

  users(principal: Principal, page: number, search: string) {
    this.auth.requirePlatformAdmin(principal);
    invariant(Number.isSafeInteger(page) && page >= 1 && page <= 100000 && search.length <= 254,
      400, "INVALID_INPUT", "Invalid user search or page");
    // Literal matching: % and _ in email addresses are not SQL wildcards.
    const query = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const total = this.db.get<{ n: number }>("SELECT count(*) n FROM users WHERE email LIKE ? ESCAPE '\\'", query)!.n;
    const pages = Math.max(1, Math.ceil(total / 10));
    page = Math.min(page, pages);
    const rows = this.db.all<{ user_id: string; email: string; created_at: string; disabled_at: string | null; machines: number; last_login: string | null }>(
      `SELECT u.user_id,u.email,u.created_at,u.disabled_at,
       (SELECT count(*) FROM machines m WHERE m.workspace_id=u.workspace_id AND m.identity_state='active') machines,
       (SELECT max(s.created_at) FROM client_sessions s WHERE s.user_id=u.user_id AND s.client_session_id NOT LIKE 'csess_service_%') last_login
       FROM users u WHERE u.email LIKE ? ESCAPE '\\' ORDER BY u.created_at DESC,u.user_id LIMIT 10 OFFSET ?`, query, (page - 1) * 10);
    return { page, pages, total, users: rows.map(row => ({
      id: row.user_id, email: row.email, createdAt: row.created_at, lastLoginAt: row.last_login,
      disabled: Boolean(row.disabled_at), platformAdmin: this.auth.isPlatformAdmin(row), machineCount: row.machines,
    })) };
  }

  change(principal: Principal, id: string, action: unknown): string[] {
    this.auth.requirePlatformAdmin(principal);
    invariant(["disable", "enable", "revoke-sessions"].includes(String(action)), 400, "INVALID_INPUT", "Invalid account action");
    const user = this.db.get<{ user_id: string; workspace_id: string; email: string }>("SELECT user_id,workspace_id,email FROM users WHERE user_id=?", id);
    invariant(user, 404, "USER_NOT_FOUND", "User was not found");
    invariant(!this.auth.isPlatformAdmin(user) && id !== principal.userId, 409, "ADMIN_ACCOUNT_PROTECTED", "The platform administrator account is protected");
    const sessions = this.db.all<{ client_session_id: string }>("SELECT client_session_id FROM client_sessions WHERE user_id=? AND revoked_at IS NULL", id);
    if (action === "disable" || action === "enable") {
      this.db.run("UPDATE users SET disabled_at=? WHERE user_id=?", action === "disable" ? nowIso() : null, id);
    }
    if (action !== "enable") {
      // Reuse lease/enrollment cleanup. Do not cancel or replay native turns.
      const subject = { ...principal, userId: id, workspaceId: user.workspace_id, email: user.email };
      for (const session of sessions) this.auth.revokeSession(subject, session.client_session_id, principal);
    }
    this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId,
      actorClientSessionId: principal.clientSessionId, action: `admin.user.${String(action)}`, metadata: { targetUserId: id } });
    return action === "enable" ? [] : sessions.map(session => session.client_session_id);
  }
}
