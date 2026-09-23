import type { ControlPlaneConfig } from "./config.js";
import { AppError, invariant } from "./errors.js";

// Only the control plane can call Django. Browser-supplied identity/email claims
// are never trusted for provisioning a workspace or issuing a session.
export class IdentityService {
  constructor(private readonly config: ControlPlaneConfig) {}

  async call(action: "request-code" | "verify-code", payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    invariant(this.config.authMode === "email" && this.config.djangoAuthUrl && this.config.djangoAuthServiceToken,
      503, "IDENTITY_UNAVAILABLE", "Email sign-in is not configured");
    let response: Response;
    let data: Record<string, unknown>;
    try {
      response = await fetch(`${this.config.djangoAuthUrl.replace(/\/$/, "")}/internal/auth/${action}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.djangoAuthServiceToken}` },
        body: JSON.stringify(payload),
      });
      data = await response.json() as Record<string, unknown>;
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid response");
    } catch {
      throw new AppError(503, "IDENTITY_UNAVAILABLE", "Email sign-in is temporarily unavailable");
    }
    if (!response.ok) {
      const code = (data.error as { code?: string } | undefined)?.code;
      const known: Record<string, [number, string]> = {
        INVALID_INPUT: [400, "Please check the email address or verification code"],
        INVALID_OR_EXPIRED_CODE: [401, "The code is invalid or expired"],
        RATE_LIMITED: [429, "Too many attempts. Please try again later."],
        EMAIL_DELIVERY_UNAVAILABLE: [503, "Email delivery is temporarily unavailable"],
      };
      const mapped = code && known[code];
      if (mapped) throw new AppError(mapped[0], code!, mapped[1], { retryAfterSeconds: data.retryAfter });
      throw new AppError(503, "IDENTITY_UNAVAILABLE", "Email sign-in is temporarily unavailable");
    }
    return data;
  }

  async requestCode(email: string, clientIp: string, locale: string) {
    const result = await this.call("request-code", { email, clientIp, locale });
    invariant(typeof result.challengeId === "string" && typeof result.expiresIn === "number" && typeof result.resendAfter === "number",
      503, "IDENTITY_UNAVAILABLE", "Email sign-in is temporarily unavailable");
    return { challengeId: result.challengeId, expiresIn: result.expiresIn, resendAfter: result.resendAfter };
  }

  async verifyCode(challengeId: string, code: string, clientIp: string) {
    const result = await this.call("verify-code", { challengeId, code, clientIp });
    const user = result.user as { id?: unknown; email?: unknown } | undefined;
    invariant(user && typeof user.id === "string" && /^[0-9a-f-]{36}$/.test(user.id)
      && typeof user.email === "string" && user.email.length <= 254 && user.email.includes("@"),
      503, "IDENTITY_UNAVAILABLE", "Email sign-in is temporarily unavailable");
    return { id: user.id as string, email: user.email as string };
  }
}
