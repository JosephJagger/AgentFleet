import { isAcpProvider, providerName, type ProviderAvailability, type AcpProviderId, type ProviderId } from "../lib/provider-catalog";
import { Check, ChevronDown, Code2, Sparkles, Layers3 } from "lucide-react";
import { useLayoutEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";

type Provider = ProviderId;
// Product display order, not a claim of real-time popularity rankings.
export const PROVIDER_DISPLAY_ORDER: ProviderId[] = ['codex', 'claude', 'cursor', 'qwen', 'kimi', 'codebuddy', 'grok'];
export function AgentPicker({ value, claudeInstalled, runtimes, onChange, allSelected=false, onAll }: { allSelected?:boolean; onAll?:()=>void; value: Provider; claudeInstalled?: boolean; runtimes?: Partial<Record<AcpProviderId, ProviderAvailability>>; onChange: (value: Provider) => void }) {
  const available = (provider: Provider) => provider === 'codex' || provider === 'claude' && claudeInstalled || isAcpProvider(provider) && runtimes?.[provider]?.state === 'ready';
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 276, maxHeight: 500 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const rect = trigger.current!.getBoundingClientRect();
    const width = Math.min(276, window.innerWidth - 24);
    const maxHeight = Math.min(500, window.innerHeight - 24);
    const top = rect.bottom + 8 + maxHeight <= window.innerHeight - 12 ? rect.bottom + 8 : Math.max(12, rect.top - 8 - maxHeight);
    setPosition({ top, maxHeight, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), width });
    const frame = requestAnimationFrame(() => {
      const selected = menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)');
      (selected ?? menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus({preventScroll:true});
    });
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    const close = () => setOpen(false);
    const scroll = (event: Event) => {
      // Capture sees scrolling inside the portaled menu too; only page scrolling invalidates its anchor.
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", close); window.removeEventListener("scroll", scroll, true); };
  }, [open]);
  function choose(provider: Provider) { onChange(provider); setOpen(false); trigger.current?.focus(); }
  return <>
    <button ref={trigger} className={`agent-picker-trigger${open ? " is-open" : ""}`} type="button" aria-label={t("选择 Agent")} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(current => !current)} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
      <span className={`agent-picker-mark agent-picker-mark--${value}`} aria-hidden="true">{allSelected ? <Layers3 size={15}/> : value === "codex" ? <Code2 size={15} /> : <Sparkles size={15} />}</span>
      <span>{allSelected ? t("全部") : providerName(value)}</span><ChevronDown className="agent-picker-chevron" size={13} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menu} id={id} className="agent-picker-menu" role="menu" aria-label={t("选择 Agent")} style={{ position: "fixed", overflowY: "auto", overscrollBehavior: "contain", ...position }} onKeyDown={event => {
      if (event.key === "Escape" || event.key === "Tab") { setOpen(false); if (event.key === "Escape") { event.preventDefault(); trigger.current?.focus(); } return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    }}>
      <div className="agent-picker-menu__label">{t("选择 Agent")}</div>
      {onAll && <button type="button" role="menuitemradio" aria-checked={allSelected} className={`agent-picker-option${allSelected ? " is-selected" : ""}`} onClick={()=>{onAll();setOpen(false);trigger.current?.focus();}}><span className="agent-picker-mark"><Layers3 size={18}/></span><span className="agent-picker-option__copy"><strong>{t("全部")}</strong><small>{t("当前主机的全部智能体会话")}</small></span>{allSelected&&<Check className="agent-picker-check" size={16}/>}</button>}
      {PROVIDER_DISPLAY_ORDER.map(provider => <button key={provider} type="button" role="menuitemradio" aria-checked={!allSelected && value === provider} disabled={!available(provider)} className={`agent-picker-option${!allSelected && value === provider ? " is-selected" : ""}`} onClick={() => choose(provider)}>
        <span className={`agent-picker-mark agent-picker-mark--${provider}`} aria-hidden="true">{provider === "codex" ? <Code2 size={18} /> : <Sparkles size={18} />}</span>
        <span className="agent-picker-option__copy"><strong>{providerName(provider)}</strong><small title={isAcpProvider(provider) ? runtimes?.[provider]?.error : undefined}>{provider === 'codex' || available(provider) ? t("宿主机项目与会话") : provider === 'claude' ? t(claudeInstalled === false ? '宿主机未安装' : '安装状态未上报') : isAcpProvider(provider) && runtimes?.[provider] ? t(runtimes[provider]?.installed === false ? '宿主机未安装' : runtimes[provider]?.state === 'login_required' ? '需要登录' : '宿主机未就绪') : t('安装状态未上报')}</small></span>
        {!allSelected && value === provider && <Check className="agent-picker-check" size={16} aria-hidden="true" />}
      </button>)}
    </div>, document.body)}
  </>;
}
