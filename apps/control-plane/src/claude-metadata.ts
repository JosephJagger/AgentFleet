/** Allowlist metadata at the host boundary; never store the native response or credentials. */
export function parseClaudeMetadata(raw: unknown) {
  const value=raw && typeof raw === "object" ? raw as Record<string,unknown> : {};
  const models:Array<{model:string;displayName:string;efforts:string[];supportsAutoMode?:boolean}> = [];
  if(Array.isArray(value.models))for(const m of value.models.slice(0,64)) {
    if(!m || typeof m !== "object" || typeof m.model !== "string" || !/^claude-[a-zA-Z0-9.-]{1,120}$/.test(m.model) || typeof m.displayName !== "string" || models.some(x=>x.model===m.model))continue;
    models.push({model:m.model,...(typeof m.supportsAutoMode === "boolean" ? {supportsAutoMode:m.supportsAutoMode} : {}),displayName:m.displayName.slice(0,120),efforts:Array.isArray(m.efforts)?m.efforts.filter((e:unknown):e is string=>typeof e === "string" && ["low","medium","high","xhigh","max"].includes(e)):[]});
  }
  const q=value.quota as Record<string,unknown>|undefined;
  const quota=q && typeof q.observedAt === "string" && Number.isFinite(Date.parse(q.observedAt)) && Date.parse(q.observedAt)<=Date.now()+60_000 ? {
    observedAt:new Date(q.observedAt).toISOString(),available:q.available===true,subscriptionType:typeof q.subscriptionType === "string"?q.subscriptionType.slice(0,40):null,
    windows:q.available===true && Array.isArray(q.windows)?q.windows.slice(0,24).flatMap(w=>{
      if(!w || typeof w !== "object" || typeof w.bucket !== "string" || typeof w.window !== "string" || typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent) || w.usedPercent<0 || w.usedPercent>100 || ![300,10080].includes(w.windowMinutes))return [];
      return [{bucket:w.bucket.slice(0,80),window:w.window.slice(0,100),usedPercent:w.usedPercent,remainingPercent:100-w.usedPercent,windowMinutes:w.windowMinutes as number,resetsAt:typeof w.resetsAt === "number" && Number.isSafeInteger(w.resetsAt) && w.resetsAt>0?w.resetsAt:null}];
    }):[],
  }:undefined;
  return {models,permissionModes:Array.isArray(value.permissionModes)?value.permissionModes.filter((mode:unknown):mode is string=>typeof mode === "string" && ["default","auto","acceptEdits","dontAsk"].includes(mode)).slice(0,4):[],...(quota?{quota}:{})};
}
