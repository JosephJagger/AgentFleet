import type { ControlPlaneDatabase } from "./db.js";
import { invariant } from "./errors.js";
/** SQLite triggers also fence old binaries and concurrent publishers during first rollout. */
export function assertVoiceAdmission(db: ControlPlaneDatabase) {
  invariant(!db.get("SELECT 1 FROM voice_deployment_guard WHERE singleton=1"),409,"VOICE_DEPLOYMENT_WAIT","面板正在等待安全更新，暂不接受新通话；已有通话继续，更新完成后请重试");
}
