import { t, systemText } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { CodexPreferences, CodexSettings, RuntimeSettings, SettingsScope, FieldOverrides, CodexCatalog } from "../lib/codex-settings";

export type RuntimeSummary = { sessionId: string; source?: CodexPreferences["source"]; settings?: CodexSettings; changed: boolean; loaded: boolean; failed?: boolean };
export type RuntimeChoice = { sessionId: string; settings?: CodexSettings };
const ignoreChoice = (_choice: RuntimeChoice) => {};
const fields = ["model", "effort", "mode", "serviceTier", "personality"] as const;
const sourceLabel = (source: string) => t(({ workspace: "统一默认", machine: "主机默认", project: "项目默认", session: "会话覆盖", codex: "Codex 自身配置" } as Record<string, string>)[source] ?? source);
function overridesOf(data: CodexPreferences, scope: SettingsScope): FieldOverrides {
  const pref = data.preferences[scope];
  return pref?.overrides ?? (pref?.settings ? Object.fromEntries(fields.map(f => [f, pref.settings![f] === undefined ? "__native__" : pref.settings![f]])) : {});
}
export function CodexSettingsPanel({ sessionId = "", machineId, projectId, workspace = false, observed, onChange = ignoreChoice, onSummary }: { sessionId?: string; machineId?: string; projectId?: string; workspace?: boolean; observed?: RuntimeSettings | null; onChange?: (choice: RuntimeChoice) => void; onSummary?: (summary: RuntimeSummary) => void }) {
  const targetScope: SettingsScope = workspace ? "workspace" : projectId ? "project" : machineId ? "machine" : "session";
  const id = projectId ?? machineId ?? sessionId;
  const [scope, setScope] = useState<SettingsScope>(targetScope);
  const [data, setData] = useState<CodexPreferences>();
  const [draft, setDraft] = useState<FieldOverrides>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); ++generation.current;
    setData(undefined); setMessage(""); setBusy(false);
    // Saved defaults are resolved by the server at submission, never frozen by
    // a stale browser summary. Explicit one-turn mode choices remain separate.
    onChange({ sessionId });
    void Promise.resolve().then(() => targetScope === "session" ? api.codexPreferences(id, controller.signal) : targetScope === "machine" ? api.machineCodexPreferences(id, controller.signal) : api.runtimePreferences(targetScope, id, controller.signal)).then(next => {
      if (controller.signal.aborted) return;
      setData(next); setDraft(overridesOf(next, scope));
    }).catch(error => { if (!controller.signal.aborted) setMessage((error as Error).message); });
    return () => controller.abort();
  }, [id, targetScope, scope, reload, sessionId, onChange]);
  useEffect(() => { onSummary?.({ sessionId, source: data?.source, settings: data?.desired ?? undefined, changed: false, loaded: !!data, failed: !data && !!message }); }, [data, message, sessionId, onSummary]);
  async function save(overrides = draft) {
    if (!data || busy) return;
    const current = generation.current; setBusy(true); setMessage("");
    try {
      // Session endpoint can edit its project's exception without losing context.
      const next = await api.saveRuntimePreferences(targetScope, id, { scope, overrides, revision: data.preferences[scope]?.revision ?? 0 });
      if (current !== generation.current) return;
      setData(next); setDraft(overridesOf(next, scope));
      setMessage(t("配置已保存，新提交的任务生效；正在执行和已排队的任务不变。"));
    } catch (error) { if (current === generation.current) setMessage((error as Error).message); }
    finally { if (current === generation.current) setBusy(false); }
  }
  const catalogs: CodexCatalog[] = workspace ? data?.catalogs?.flatMap(item => item.catalog && !item.catalog.error ? [item.catalog] : []) ?? [] : data?.catalog && !data.catalog.error ? [data.catalog] : [];
  const models = [...new Map(catalogs.flatMap(c => c.models).map(m => [m.model, m])).values()];
  const effective = { ...data?.effective };
  // Build preview from parents and this scope; exclude this scope's old fields.
  for (const field of fields) {
    delete effective[field];
    for (const parent of ["workspace", "machine", "project", "session"] as const) {
      if (parent === scope) break;
      const value = data ? overridesOf(data, parent)[field] : undefined;
      if (value !== undefined) effective[field] = value;
    }
    if (draft[field] !== undefined) effective[field] = draft[field];
  }
  const modelId = effective.model && effective.model !== "__native__" ? effective.model : data?.desired?.model ?? observed?.observed?.model;
  const supportedModels = catalogs.flatMap(c => c.models.filter(m => m.model === modelId));
  const unique = (values: string[]) => [...new Set(values)];
  const options: Record<keyof CodexSettings, { value: string; label: string }[]> = {
    model: models.map(m => ({ value: m.model, label: m.displayName })),
    effort: unique(supportedModels.flatMap(m => m.efforts)).map(value => ({ value, label: value })),
    mode: unique(catalogs.flatMap(c => c.modes)).map(value => ({ value, label: t(value === "plan" ? "计划" : "执行") })),
    serviceTier: [{ value: "__clear__", label: t("恢复默认档位") }, ...[...new Map(supportedModels.flatMap(m => m.serviceTiers ?? []).map(v => [v.id, v])).values()].map(v => ({ value: v.id, label: v.name }))],
    personality: supportedModels.some(m => m.supportsPersonality) ? ["none", "friendly", "pragmatic"].map(value => ({ value, label: t(({ none: "不指定风格", friendly: "友好", pragmatic: "务实" })[value as "none"] ) })) : [],
  };
  const labels = { model: "模型", effort: "推理强度", mode: "协作模式", serviceTier: "服务档位", personality: "沟通风格" };
  const changed = !!data && JSON.stringify(draft) !== JSON.stringify(overridesOf(data, scope));
  return <details className="codex-settings-panel session-config-section" open={targetScope !== "session"}>
    <summary><span>{t(targetScope === "session" ? "运行配置" : "默认运行配置")}<small>{data ? `${sourceLabel(data.source)} · ${data.desired?.model ?? t("继承 Codex")}` : t("读取中")}</small></span></summary>
    <p>{t("逐项继承：统一默认 → 主机 → 项目 → 会话。只修改需要覆盖的选项。")}</p>
    {targetScope === "session" && <label>{t("保存范围")}<select disabled={busy} value={scope} aria-label={t("配置保存范围")} onChange={e => setScope(e.target.value as SettingsScope)}><option value="session">{t("仅此会话")}</option><option value="project">{t("此项目中未单独覆盖的会话")}</option></select></label>}
    {data && <div className="codex-settings-fields">{fields.map(field => {
      const value = draft[field] === null ? "__clear__" : draft[field] ?? "";
      return <label key={field}>{t(labels[field])}<select aria-label={t(labels[field])} value={value} disabled={busy} onChange={e => setDraft(previous => {
        const next = { ...previous }; if (!e.target.value) delete next[field]; else next[field] = e.target.value === "__clear__" ? null : e.target.value; return next;
      })}>
        <option value="">{t("继承上级")}</option><option value="__native__">{t("使用原生值（不继承上级）")}</option>
        {value && !["__native__", ...options[field].map(o => o.value)].includes(value) && <option value={value}>{value} · {t("当前目录未提供")}</option>}
        {options[field].map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select><small>{t("已保存来源：")}{sourceLabel(data.sources?.[field] ?? data.source)} · {data.effective?.[field] === "__native__" || data.effective?.[field] === undefined ? t("原生值") : data.effective[field] === null ? t("恢复默认档位") : data.effective[field]}</small></label>;
    })}</div>}
    {workspace && <p className="subtle">{t("选项来自各主机上报的目录；任务提交时按目标主机再次校验，不会自动替换模型。")}</p>}
    {!workspace && data?.compatibilityIssue && <p role="alert">{systemText(data.compatibilityIssue)}</p>}
    {data && !catalogs.length && <p>{t("暂无可用模型目录，可清除覆盖或刷新后重试。")}</p>}
    {changed && <p role="status">{t("修改尚未保存。")}</p>}
    <div className="codex-settings-save"><button className="button button--primary" type="button" disabled={!data || busy || !changed} onClick={() => void save()}>{t("保存配置")}</button><button className="button button--quiet" type="button" disabled={!data || busy || !Object.keys(overridesOf(data, scope)).length} onClick={() => void save({})}>{t("全部恢复继承")}</button><button className="button button--quiet" type="button" disabled={busy} onClick={() => setReload(n => n + 1)}>{t("重新读取配置")}</button></div>
    {observed?.accepted && <p className="subtle">{t("主机上次接受：")}{observed.accepted.model} · {observed.accepted.effort ?? t("继承强度")}</p>}
    {message && <p role="status">{systemText(message)}</p>}
  </details>;
}
