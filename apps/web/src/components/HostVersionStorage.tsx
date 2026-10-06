import { useEffect, useRef, useState } from "react";
import { Archive, RefreshCw, Trash2, LoaderCircle } from "lucide-react";
import { api } from "../lib/api";
import { t, locale, systemText } from "../i18n";
import { imageSpace } from "../lib/image-space";
import type { HostOperation, Machine } from "../lib/types";
import { HostDisclosure } from "./HostDisclosure";

type Report = { checkedAt: string; totalBytes: number; reclaimableBytes: number; deletedBytes: number; deletedCount: number; entryCount: number; entries: {kind:string;name:string;bytes:number;reason:string}[] };
function reportOf(operation?: HostOperation): Report | undefined {
  const r=operation?.result;
  return r && typeof r.checkedAt === "string" && typeof r.reclaimableBytes === "number" && Array.isArray(r.entries) ? r as Report : undefined;
}
export function HostVersionStorage({ machine }: { machine: Machine }) {
  const [operation,setOperation]=useState<HostOperation>();
  const [report,setReport]=useState<Report>();
  const [error,setError]=useState("");const [sending,setSending]=useState(false);const submitting=useRef(false);
  const supported=machine.maintenanceCapabilities?.includes("versions.preview") && machine.maintenanceCapabilities?.includes("versions.clean");
  const online=machine.reachability==="live";
  const pending=sending||operation?.state==="accepted"||operation?.state==="running"||operation?.state==="unknown";
  useEffect(()=>{const controller=new AbortController();void api.hostOperations(machine.id,controller.signal).then(items=>{if(controller.signal.aborted)return;const versions=items.filter(o=>o.type==="versions.preview"||o.type==="versions.clean");setOperation(versions[0]);setError(versions[0]?.error?.message??"");setReport(versions.map(reportOf).find(Boolean));}).catch(()=>{});return()=>controller.abort();},[machine.id]);
  useEffect(()=>{
    if(!operation||!["accepted","running","unknown"].includes(operation.state))return;
    let disposed=false,inflight=false;
    const poll=async()=>{if(inflight)return;inflight=true;try{const next=await api.readHostOperation(operation.id);if(!disposed){setOperation(next);const r=reportOf(next);if(r)setReport(r);setError(next.error?.message??"");}}catch(e){if(!disposed)setError((e as Error).message);}finally{inflight=false;}};
    const timer=setInterval(()=>void poll(),3000);void poll();return()=>{disposed=true;clearInterval(timer);};
  },[operation?.id,operation?.state]);
  const operate=async(clean:boolean)=>{
    if(submitting.current||pending||!online||!supported)return;submitting.current=true;setSending(true);setError("");
    try{const next=await api.hostOperation(machine.id,clean?"versions.clean":"versions.preview",crypto.randomUUID());setOperation(next);}
    catch(e){setError((e as Error).message);}finally{submitting.current=false;setSending(false);}
  };
  const description=!supported?t("更新连接服务后可检查旧版本"):report?report.reclaimableBytes>0?t("可清理 {0} · 保留在用和回退版本",imageSpace(report.reclaimableBytes)):t("无需清理 · 在用和回退版本已保留"):t("检查旧安装包、托管 Codex 和升级备份");
  const kind=(value:string)=>value==="agent"?"AgentFleets":value==="codex"?"Codex":t("升级备份");
  const reason=(value:string)=>value==="current"?t("当前版本"):value==="rollback"?t("回退版本"):value==="referenced"?t("仍在使用"):value==="recent"?t("刚安装，暂时保留"):value==="unsafe"?t("需人工核查"):t("可清理");
  return <HostDisclosure title={t("版本清理")} description={description} icon={<Archive size={21}/>} className="host-version-storage">
    <p className="subtle">{t("安装或升级成功后会自动清理旧版本，保留当前版、一个回退版和仍被引用的文件。这里可检查是否还有可清理内容。")}</p>
    {!supported?<p role="status">{t("请先在「状态与连接」更新连接服务。")}</p>:<>
      <div className="version-storage-summary"><div><small>{t("版本文件占用")}</small><strong>{report?imageSpace(report.totalBytes):"—"}</strong></div><div><small>{t("可释放空间")}</small><strong>{report?imageSpace(report.reclaimableBytes):"—"}</strong></div></div>
      <div className="version-storage-actions"><button className="button button--secondary" type="button" disabled={!online||pending} onClick={()=>void operate(false)}><RefreshCw size={16}/>{t("检查版本")}</button><button className="button button--primary" type="button" disabled={!online||pending||!report?.reclaimableBytes} onClick={()=>void operate(true)}><Trash2 size={16}/>{t("一键清理旧版本")}</button></div>
      {!online&&<p role="status">{t("主机离线，连接后可检查和清理。")}</p>}
      {pending&&<p className="version-storage-status" role="status"><LoaderCircle size={16} className="spin"/>{operation?.state==="unknown"?t("结果待核验，请勿重复清理"):t("正在核查主机版本文件…")}</p>}
      {operation?.state==="succeeded"&&operation.type==="versions.clean"&&report&&<p role="status">{t("已清理 {0}，删除 {1} 个旧版本目录。",imageSpace(report.deletedBytes),report.deletedCount)}</p>}
      {operation?.state==="expired"&&<p role="status">{t("操作已过期，请重新检查版本。")}</p>}
      {report&&<><p className="subtle">{t("上次检查：{0}",new Date(report.checkedAt).toLocaleString(locale()))}</p><details><summary>{t("查看保留和清理明细")}</summary><ul className="version-storage-list">{report.entries.map(e=><li key={`${e.kind}:${e.name}`}><div><strong>{kind(e.kind)}</strong><span>{e.name}</span></div><div><span>{imageSpace(e.bytes)}</span><small>{reason(e.reason)}</small></div></li>)}</ul>{report.entryCount>report.entries.length&&<p className="subtle">{t("仅展示前 {0} 项，总占用已包含全部目录。",report.entries.length)}</p>}</details></>}
    </>}
    {error&&<p className="catalog-error" role="alert">{systemText(error)}</p>}
  </HostDisclosure>;
}
