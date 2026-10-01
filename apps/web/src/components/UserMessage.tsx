import { Mic } from "lucide-react";
import { t } from "../i18n";

/** Presentation only: never change the prompt stored or delivered to Codex. */
export function parseVoiceRequest(body: string) {
  const match = /^\s*<realtime_delegation>\s*<input>([\s\S]*?)<\/input>\s*(?:<transcript_delta>([\s\S]*?)<\/transcript_delta>\s*)?<\/realtime_delegation>\s*$/.exec(body);
  return match ? { input: match[1].trim(), transcript: match[2]?.trim() ?? "" } : null;
}

export function UserMessage({ body }: { body: string }) {
  const voice = parseVoiceRequest(body);
  if (!voice) return <p>{body}</p>;
  return <details className="voice-request">
    <summary>
      <span className="voice-request__label"><Mic size={15} aria-hidden="true" />{t("语音请求")}<span>{t("展开记录")}</span></span>
      <span className="voice-request__preview">{voice.input}</span>
    </summary>
    <div className="voice-request__content" tabIndex={0} aria-label={t("语音记录")}>
      <p>{voice.input}</p>
      {voice.transcript && <><strong>{t("本次语音转写")}</strong><p>{voice.transcript}</p></>}
    </div>
  </details>;
}
