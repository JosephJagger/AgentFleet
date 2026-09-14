import { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { t } from "../i18n";
import { api } from "../lib/api";

const presets = {
  deepseek: { endpoint: "https://api.deepseek.com", model: "deepseek-flash" },
  openai: { endpoint: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  custom: { endpoint: "", model: "" },
};
type Provider = keyof typeof presets;
function providerFor(endpoint: string): Provider {
  try { const host=new URL(endpoint).hostname;return host === 'api.deepseek.com' ? 'deepseek' : host === 'api.openai.com' ? 'openai' : 'custom'; } catch { return 'custom'; }
}
export function WritingAISettings() {
  const [provider,setProvider] = useState<Provider>('deepseek');
  const [endpoint,setEndpoint] = useState("");
  const [model,setModel] = useState("");
  const [savedModel,setSavedModel] = useState("");
  const [expanded,setExpanded] = useState(false);
  const fieldsId = useId();
  const [apiKey,setApiKey] = useState("");
  const [enabled,setEnabled] = useState(false);
  const [hasKey,setHasKey] = useState(false);
  const [clearKey,setClearKey] = useState(false);
  const [ready,setReady] = useState(false);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  useEffect(()=>{let active=true;void Promise.resolve().then(()=>api.writingAI()).then(value=>{if(active){setProvider(value.endpoint ? providerFor(value.endpoint) : "deepseek");setEndpoint(value.endpoint || presets.deepseek.endpoint);setModel(value.model || (value.endpoint ? "" : presets.deepseek.model));setSavedModel(value.model);setEnabled(value.enabled);setHasKey(value.hasKey);setReady(true);}}).catch(()=>{if(active)setMessage(t("AI 配置暂不可用，基础补全与学习不受影响"));});return()=>{active=false;};},[]);
  return <section className="settings-block writing-ai-settings"><h2>{t("AI 理解配置")}</h2>
    <p className="subtle">{t("可选：连接兼容 Chat Completions 的模型服务。未配置时使用基础词库和自动学习；仅点击“优化表达”时发送当前草稿与可用词条，可能产生模型费用。")}</p>
    <form onSubmit={event=>{event.preventDefault();if(busy)return;setBusy(true);setMessage("");void api.saveWritingAI({endpoint,model,apiKey,enabled,clearKey}).then(value=>{setApiKey("");setSavedModel(value.model);setHasKey(value.hasKey);setClearKey(false);setMessage(t("AI 配置已保存"));}).catch(()=>setMessage(t("AI 配置保存失败，请检查地址与模型名称"))).finally(()=>setBusy(false));}}>
      <label className="writing-toggle"><input type="checkbox" checked={enabled} disabled={!ready || busy} onChange={event=>setEnabled(event.target.checked)} />{t("启用 AI 理解")}</label>
      <div className="settings-more" data-expanded={expanded}>
      <button type="button" className="settings-more-toggle" aria-expanded={expanded} aria-controls={fieldsId} onClick={()=>setExpanded(value=>!value)}>
        <span><strong>{expanded ? t("收起连接配置") : t("查看与编辑连接配置")}</strong><small>{ready ? savedModel ? t("已保存模型：{0}",savedModel) : t("尚未配置模型") : t("读取中")}</small></span><ChevronDown size={16} aria-hidden="true" />
      </button>
      <div id={fieldsId} className="settings-more-fields" hidden={!expanded} onInvalidCapture={event => { event.preventDefault();setExpanded(true);const target=event.target as HTMLInputElement;requestAnimationFrame(()=>target.focus()); }}>
      <label className="settings-field">{t("AI 服务商")}<select value={provider} disabled={!ready || busy} onChange={event=>{
        const next=event.target.value as Provider;setProvider(next);setEndpoint(presets[next].endpoint);setModel(presets[next].model);setApiKey("");setHasKey(false);setClearKey(false);setMessage("");
      }}><option value="deepseek">DeepSeek</option><option value="openai">OpenAI (ChatGPT)</option><option value="custom">{t("自定义兼容接口")}</option></select></label>
      <p className="subtle">{provider === 'deepseek' ? t("已预填 DeepSeek 官方地址与模型；表达优化关闭思考，只返回精炼改写。") : provider === 'openai' ? t("已预填 OpenAI 官方地址与快速模型，使用 OpenAI API 密钥；模型可修改。") : t("填写兼容 Chat Completions 的基础地址与模型名称。")}</p>
      <label className="settings-field">{t("API 基础地址")}<input type="url" required placeholder="https://api.example.com/v1" value={endpoint} onChange={event=>{setEndpoint(event.target.value);setProvider(providerFor(event.target.value));setApiKey("");setHasKey(false);}} /></label>
      <label className="settings-field">{t("模型名称")}<input required maxLength={200} value={model} onChange={event=>setModel(event.target.value)} /></label>
      <label className="settings-field">{t("API 密钥")}<input type="password" autoComplete="new-password" value={apiKey} maxLength={4096} placeholder={hasKey ? t("已保存，留空保留；更换地址需重新填写") : t("服务无需密钥时可留空")} onChange={event=>setApiKey(event.target.value)} /></label>
      {hasKey && <label className="writing-toggle"><input type="checkbox" checked={clearKey} onChange={event=>setClearKey(event.target.checked)} />{t("移除已保存密钥")}</label>}
      </div>
      </div>
      <button className="button button--primary" disabled={!ready || busy}>{busy ? t("正在保存…") : t("保存 AI 配置")}</button>
    </form>
    {message && <p role="status">{message}</p>}
  </section>;
}
