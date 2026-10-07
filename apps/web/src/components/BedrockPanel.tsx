import { Cloud } from "lucide-react";
import { ConfigDisclosureSummary } from "./ConfigDisclosureSummary";
import { useEffect, useRef, useState } from "react";
import { t, systemText } from "../i18n";
import type { HostOperation, Machine, CommandReceipt } from "../lib/types";
import { useCodexOperation } from "./useCodexOperation";
export function BedrockPanel(props:{machine:Machine;hostOperations:HostOperation[];onChanged:()=>void}) {
 const op=useCodexOperation(props);const [profiles,setProfiles]=useState<NonNullable<CommandReceipt["codexResult"]>["rows"]>([]);const [profile,setProfile]=useState("");const [region,setRegion]=useState("");const [confirmed,setConfirmed]=useState(false);const applied=useRef<string|undefined>(undefined);
 useEffect(()=>{if(!op.id||!op.result||applied.current===op.id)return;applied.current=op.id;if(op.result.operation==="bedrock.discover"){setProfiles(op.result.rows);setProfile("");setRegion("");setConfirmed(false);}if(op.result.operation==="bedrock.setup")setConfirmed(false);},[op.id,op.result]);
 return <details className="codex-settings-panel config-disclosure"><ConfigDisclosureSummary icon={Cloud}>{t("使用主机上的 Amazon Bedrock 配置")}</ConfigDisclosureSummary><div className="stack-form config-disclosure__body"><p>{t("仅使用主机已配置的 AWS profile，不在面板输入或上传密钥。切换会影响此主机后续 Codex 连接及计费来源。")}</p><button type="button" disabled={!op.allowed||op.pending} onClick={()=>void op.run("bedrock.discover")}>{t("读取主机 AWS 配置")}</button>
 {profiles.length>0&&<><label>{t("AWS 配置")}<select value={profile} onChange={e=>{setProfile(e.target.value);setRegion(profiles.find(p=>p.name===e.target.value)?.detail??"");setConfirmed(false);}}><option value="">{t("请选择")}</option>{profiles.map(p=><option key={p.name} value={p.name}>{p.name}</option>)}</select></label><label>{t("AWS 区域")}<input value={region} placeholder="us-east-1" onChange={e=>{setRegion(e.target.value);setConfirmed(false);}}/></label><label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{t("确认切换此主机的模型提供方")}</label><button type="button" disabled={!op.allowed||op.pending||!confirmed||!profile||!region} onClick={()=>void op.run("bedrock.setup",{profile,region,confirmed:true})}>{t("保存")}</button></>}
 {op.result?.operation==="bedrock.discover"&&!profiles.length&&<p>{t("此主机没有可用的 AWS profile，请先在主机本地配置。")}</p>}{op.result?.status==="savedRequiresReconnect"&&<p>{t("已保存，重新连接 Codex 后生效。运行中任务不会被中断。")}</p>}{op.error&&<p role="alert">{systemText(op.error)}</p>}
 </div></details>;
}
