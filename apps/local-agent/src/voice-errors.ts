// Never forward native error bodies: they can contain endpoints or credentials.
export function voiceErrorCode(message: unknown): string {
  const text = typeof message === 'string' ? message.toLowerCase() : '';
  const status = text.match(/(?:http|status(?: code)?)[\s:=]+(400|401|403|404|408|409|429|500|502|503|504)\b/);
  if (status) return `VOICE_HTTP_${status[1]}`;
  if (/unauthorized|authentication|not authenticated|sign in|login required/.test(text)) return 'VOICE_AUTH';
  if (/quota|rate.limit|too many requests/.test(text)) return 'VOICE_LIMIT';
  if (/sdp|codec|webrtc.*invalid|invalid.*webrtc/.test(text)) return 'VOICE_SDP';
  if (/timeout|timed out/.test(text)) return 'VOICE_TIMEOUT';
  if (/sideband/.test(text)) return 'VOICE_SIDEBAND';
  if (/already.*active|already.*started/.test(text)) return 'VOICE_BUSY';
  return 'VOICE_NATIVE_ERROR';
}
