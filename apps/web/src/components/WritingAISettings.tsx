import { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { t } from "../i18n";
import { api } from "../lib/api";

export function WritingAISettings() {
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
  useEffect(()=>{let active=true;void Promise.resolve().then(()=>api.writingAI()).then(value=>{if(active){setEndpoint(value.endpoint);setModel(value.model);setSavedModel(value.model);setEnabled(value.enabled);setHasKey(value.hasKey);setReady(true);}}).catch(()=>{if(active)setMessage(t("AI 配置暂不可用，基础补全与学习不受影响"));});return()=>{active=false;};},[]);
  return <section className="settings-block writing-ai-settings"><h2>{t("AI 理解配置")}</h2>
    <p className="subtle">{t("可选：连接兼容 Chat Completions 的模型服务。未配置时使用基础词库和自动学习；仅点击 AI 优化时发送当前草稿与可用词条，可能产生模型费用。")}</p>
    <form onSubmit={event=>{event.preventDefault();if(busy)return;setBusy(true);setMessage("");void api.saveWritingAI({endpoint,model,apiKey,enabled,clearKey}).then(value=>{setApiKey("");setSavedModel(value.model);setHasKey(value.hasKey);setClearKey(false);setMessage(t("AI 配置已保存"));}).catch(()=>setMessage(t("AI 配置保存失败，请检查地址与模型名称"))).finally(()=>setBusy(false));}}>
      <label className="writing-toggle"><input type="checkbox" checked={enabled} disabled={!ready || busy} onChange={event=>setEnabled(event.target.checked)} />{t("启用 AI 理解")}</label>
      <div className="settings-more" data-expanded={expanded}>
      <button type="button" className="settings-more-toggle" aria-expanded={expanded} aria-controls={fieldsId} onClick={()=>setExpanded(value=>!value)}>
        <span><strong>{expanded ? t("收起连接配置") : t("查看与编辑连接配置")}</strong><small>{ready ? savedModel ? t("已保存模型：{0}",savedModel) : t("尚未配置模型") : t("读取中")}</small></span><ChevronDown size={16} aria-hidden="true" />
      </button>
      <div id={fieldsId} className="settings-more-fields" hidden={!expanded} onInvalidCapture={event => { event.preventDefault();setExpanded(true);const target=event.target as HTMLInputElement;requestAnimationFrame(()=>target.focus()); }}>
      <label className="settings-field">{t("API 基础地址")}<input type="url" required placeholder="https://api.example.com/v1" value={endpoint} onChange={event=>setEndpoint(event.target.value)} /></label>
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
