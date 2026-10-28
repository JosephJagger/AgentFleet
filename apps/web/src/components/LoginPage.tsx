import { Clock3, Laptop, LockKeyhole, Monitor, Server, ShieldCheck } from "lucide-react";
import { t, useLocale } from "../i18n";
import type { Dashboard } from "../lib/types";
import { EmailLoginForm } from "./EmailLoginForm";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeEmblem, ThemeSwitcher } from "./ThemeSwitcher";

export function LoginPage({ onLogin }: { onLogin: (dashboard: Dashboard) => void }) {
  useLocale();
  return <main className="login-page">
    <header className="login-header">
      <div className="login-brand">
        <span className="login-brand__mark"><ThemeEmblem /></span>
        <span>AgentFleets</span>
      </div>
      <div className="login-preferences">
        <LanguageSwitcher compact />
        <ThemeSwitcher nameOnly />
      </div>
    </header>

    <div className="login-layout">
      <section className="login-intro" aria-labelledby="login-heading">
        <p className="login-kicker">{t("多智能体 · 多主机工作台")}</p>
        <h1 className="login-heading" id="login-heading">{t("随时接续你的工作")}</h1>
        <p className="login-description">{t("在一个工作台连接 Codex、Claude Code 与你的多台主机。")}</p>
      </section>

      <section className="login-card" aria-labelledby="login-title">
        <div className="login-card__heading">
          <span className="login-card__icon" aria-hidden="true"><LockKeyhole size={19} /></span>
          <h2 id="login-title">{t("登录你的工作区")}</h2>
          <p>{t("我们会向你的邮箱发送验证码。")}</p>
        </div>
        <EmailLoginForm onLogin={onLogin} />
        <p className="login-create-note">{t("首次登录将创建你的工作区。")}</p>
        <div className="login-card__foot"><ShieldCheck size={15} aria-hidden="true" /><span>{t("登录后可随时撤销浏览器会话。")}</span></div>
      </section>

      <div className="login-connections">
        <div className="login-visual" role="img" aria-label={t("在同一个工作台连接 Linux、macOS 与 Windows 上的智能体") }>
          <div className="login-scene" />
          <div className="login-hosts">
            <span><Server size={18} />Linux</span>
            <span><Laptop size={18} />macOS</span>
            <span><Monitor size={18} />Windows</span>
          </div>
          <div className="login-routes" />
          <div className="login-hub"><ThemeEmblem /></div>
        </div>
        <p className="login-agents"><span>Codex</span><span>Claude Code</span><span>Cursor</span><span>Grok</span></p>
        <p className="login-host-note">{t("代码在你的主机上运行，会话从这里接续。")}</p>
      </div>
    </div>

    <footer className="login-footer">
      <span><ShieldCheck size={15} aria-hidden="true" />{t("权限按需配置")}</span>
      <span><LockKeyhole size={15} aria-hidden="true" />{t("无入站端口")}</span>
      <span><Clock3 size={15} aria-hidden="true" />{t("正文保留 1–30 天")}</span>
    </footer>
  </main>;
}
