import { Check, ChevronDown, Code2, Sparkles } from "lucide-react";
import { useLayoutEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";

type Provider = "codex" | "claude";
export function AgentPicker({ value, claudeInstalled, onChange }: { value: Provider; claudeInstalled: boolean; onChange: (value: Provider) => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 276 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const rect = trigger.current!.getBoundingClientRect();
    const width = Math.min(276, window.innerWidth - 24);
    setPosition({ top: rect.bottom + 8, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), width });
    const frame = requestAnimationFrame(() => {
      const selected = menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)');
      (selected ?? menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    });
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [open]);
  function choose(provider: Provider) { onChange(provider); setOpen(false); trigger.current?.focus(); }
  return <>
    <button ref={trigger} className={`agent-picker-trigger${open ? " is-open" : ""}`} type="button" aria-label={t("选择 Agent")} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(current => !current)} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
      <span className={`agent-picker-mark agent-picker-mark--${value}`} aria-hidden="true">{value === "codex" ? <Code2 size={15} /> : <Sparkles size={15} />}</span>
      <span>{value === "codex" ? "Codex" : "Claude Code"}</span><ChevronDown className="agent-picker-chevron" size={13} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menu} id={id} className="agent-picker-menu" role="menu" aria-label={t("选择 Agent")} style={{ position: "fixed", ...position }} onKeyDown={event => {
      if (event.key === "Escape" || event.key === "Tab") { setOpen(false); if (event.key === "Escape") { event.preventDefault(); trigger.current?.focus(); } return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    }}>
      <div className="agent-picker-menu__label">{t("选择 Agent")}</div>
      {(["codex", "claude"] as const).map(provider => <button key={provider} type="button" role="menuitemradio" aria-checked={value === provider} disabled={provider === "claude" && !claudeInstalled} className={`agent-picker-option${value === provider ? " is-selected" : ""}`} onClick={() => choose(provider)}>
        <span className={`agent-picker-mark agent-picker-mark--${provider}`} aria-hidden="true">{provider === "codex" ? <Code2 size={18} /> : <Sparkles size={18} />}</span>
        <span className="agent-picker-option__copy"><strong>{provider === "codex" ? "Codex" : "Claude Code"}</strong><small>{provider === "claude" && !claudeInstalled ? t("宿主机未安装") : t("宿主机项目与会话")}</small></span>
        {value === provider && <Check className="agent-picker-check" size={16} aria-hidden="true" />}
      </button>)}
    </div>, document.body)}
  </>;
}
