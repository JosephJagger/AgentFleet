import type { ControlPlaneDatabase } from "./db.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";
import { nowIso } from "./crypto.js";
import { REALTIME_VOICES, parseRealtimeVoice } from "./voice-options.js";

export class VoicePreferencesService {
  constructor(private db: ControlPlaneDatabase) {}
  read(principal: Principal) {
    const row = this.db.get<{voice: string; revision: number}>("SELECT voice,revision FROM voice_preferences WHERE workspace_id=?", principal.workspaceId);
    return { voice: row?.voice ?? "sol", revision: row?.revision ?? 0, voices: REALTIME_VOICES };
  }
  write(principal: Principal, input: Record<string, unknown>) {
    invariant(Object.keys(input).every(k => ["voice", "revision"].includes(k)) && typeof input.voice === "string", 400, "VOICE_INVALID", "请选择语音音色");
    const voice = parseRealtimeVoice(input.voice);
    invariant(Number.isSafeInteger(input.revision) && Number(input.revision) >= 0, 400, "INVALID_SETTINGS_REVISION", "Settings revision is required");
    return this.db.transaction(() => {
      const current = this.read(principal);
      invariant(current.revision === input.revision, 409, "SETTINGS_REVISION_CONFLICT", "Settings changed in another browser; reload before saving");
      this.db.run(`INSERT INTO voice_preferences(workspace_id,voice,revision,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(workspace_id) DO UPDATE SET voice=excluded.voice,revision=excluded.revision,updated_at=excluded.updated_at`, principal.workspaceId,voice,current.revision+1,nowIso());
      this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, action: "voice.preferences.save", metadata: { voice, revision: current.revision+1 } });
      return this.read(principal);
    });
  }
  forStart(principal: Principal, agentVersion: string) {
    const voice = this.read(principal).voice;
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(agentVersion);
    const supported = match && (+match[1]! > 0 || +match[2]! > 30 || +match[2]! === 30 && +match[3]! >= 73);
    invariant(voice === "sol" || supported, 409, "VOICE_AGENT_UPDATE", "所选音色需要连接服务 0.30.73 或更新版本，请先更新语音主机");
    return voice;
  }
}
