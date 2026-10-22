import { displayName } from "../lib/display-name";
import { useEffect, useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { PROVIDER_IDS, providerName, type ProviderId } from "../lib/provider-catalog";
import type { Machine } from "../lib/types";
import type { UsageBreakdownEntry, UsageSummary } from "../lib/usage";
import { pageItems } from "../lib/pagination";
import { locale, t } from "../i18n";

const cacheRate=(input:number|null|undefined,cached:number|null|undefined)=>input&&cached!=null?cached/input*100:null;
const pageSize=10;
export function UsageView({machines,selectedId,onSelect,onSession}:{machines:Machine[];selectedId?:string;onSelect:(id:string)=>void;onSession:(id:string)=>void}) {
  const machine=machines.find(item=>item.id===selectedId)??machines[0];
  const [data,setData]=useState<UsageSummary>();
  const [loading,setLoading]=useState(false);
  const [failed,setFailed]=useState(false);
  const [refreshing,setRefreshing]=useState(false);
  const [projectPage,setProjectPage]=useState(1);
  const [sessionPage,setSessionPage]=useState(1);
  const [provider,setProvider]=useState<ProviderId>("codex");
  const number=(value:number|null|undefined)=>value==null?"—":new Intl.NumberFormat(locale()).format(value);
  const percent=(value:number|null)=>value==null?t("未记录"):t("{0}%",new Intl.NumberFormat(locale(),{maximumFractionDigits:1}).format(value));
  const date=(value:string)=>new Date(value).toLocaleString(locale());
  const creditBalance=(value:string)=>{const parsed=Number(value);return Number.isFinite(parsed)?new Intl.NumberFormat(locale(),{maximumFractionDigits:20}).format(parsed):value;};
  const creditText=(credits:UsageSummary["accounts"][number]["credits"])=>credits?.unlimited?t("不限"):credits?.balance!=null?t("{0} 点",creditBalance(credits.balance)):credits?.hasCredits===false?t("无可用点数"):t("未提供");
  const load=async(signal?:AbortSignal)=>{if(!machine)return;setLoading(true);try{setData(await api.usage("machine",machine.id,signal,provider));setFailed(false);}catch(error){if(!(error instanceof DOMException&&error.name==="AbortError"))setFailed(true);}finally{if(!signal?.aborted)setLoading(false);}};
  useEffect(()=>{setData(undefined);setFailed(false);setProjectPage(1);setSessionPage(1);const controller=new AbortController();void load(controller.signal);return()=>controller.abort();},[machine?.id,provider]);
  async function refresh(){if(!machine)return;setRefreshing(true);try{await api.refreshQuota(machine.id);await load();}finally{setRefreshing(false);}}
  const weeklyRate=cacheRate(data?.quotaCycle?.inputTokens,data?.quotaCycle?.cachedInputTokens);
  const weekly=data?.accounts.flatMap(account=>account.windows.filter(window=>window.bucket===provider&&window.windowMinutes===10080).map(window=>({account,window})))??[];
  const accountCredits=data?.accounts.length===1?data.accounts[0]?.credits:null;
  const rows=(entries:UsageBreakdownEntry[]|undefined,session=false,page=1,setPage:(page:number)=>void=()=>{})=>{
    const totalPages=Math.max(1,Math.ceil((entries?.length??0)/pageSize));
    const safePage=Math.min(page,totalPages);
    const visible=entries?.slice((safePage-1)*pageSize,safePage*pageSize);
    return <>
      <div className="usage-table-wrap"><table className="usage-table"><caption className="usage-sr-only">{session?t("会话消耗"):t("项目消耗")} · tokens</caption><thead><tr><th>{session?t("会话"):t("项目")}</th><th scope="col">{t("累计")}</th><th scope="col">{t("本周")}</th><th scope="col">{t("缓存命中")}</th></tr></thead><tbody>{visible?.length?visible.map(entry=><tr key={entry.id}><td>{session?<button className="usage-table__name" title={displayName(entry.title)} type="button" onClick={()=>onSession(entry.id)}>{displayName(entry.title)}</button>:<span className="usage-table__name" title={displayName(entry.title)}>{displayName(entry.title)}</span>}</td><td data-label={t("累计")} title={`${number(entry.totalTokens)} tokens`}>{number(entry.totalTokens)}</td><td data-label={t("本周")} title={`${number(entry.weeklyTokens)} tokens`}>{number(entry.weeklyTokens)}</td><td data-label={t("缓存命中")}>{percent(cacheRate(entry.weeklyInputTokens,entry.weeklyCachedInputTokens))}</td></tr>):<tr><td colSpan={4} className="usage-table-empty">{loading?t("正在读取用量…"):t("尚无已记录用量")}</td></tr>}</tbody></table></div>
      {totalPages>1&&<nav className="usage-pagination" aria-label={session?t("会话分页"):t("项目分页")}>
        <button type="button" disabled={safePage===1} onClick={()=>setPage(safePage-1)}>{t("上一页")}</button>
        {pageItems(safePage,totalPages).map((item,index)=>item==="ellipsis"?<span key={`ellipsis-${index}`} aria-hidden="true">…</span>:<button key={item} type="button" aria-current={item===safePage?"page":undefined} aria-label={t("第 {0} 页",item)} onClick={()=>setPage(item)}>{item}</button>)}
        <button type="button" disabled={safePage===totalPages} onClick={()=>setPage(safePage+1)}>{t("下一页")}</button>
      </nav>}
    </>;
  };
  return <section className="wide-view usage-view">
    <div className="wide-view__heading"><div><h1>{t("消耗")}</h1></div><BarChart3 size={30}/></div>
    {!machine?<div className="usage-empty"><h2>{t("暂无主机")}</h2><p>{t("连接主机后，用量会在这里按项目和会话汇总。")}</p></div>:<>
      <div className="usage-toolbar"><label><span>{t("主机")}</span><select value={machine.id} onChange={event=>onSelect(event.target.value)}>{machines.map(item=><option key={item.id} value={item.id}>{displayName(item.name)}</option>)}</select></label><label><span>{t("智能体")}</span><select aria-label={t("用量智能体")} value={provider} onChange={event=>setProvider(event.target.value as ProviderId)}>{PROVIDER_IDS.map(id=><option key={id} value={id}>{providerName(id)}</option>)}</select></label><button className="button button--quiet" type="button" disabled={refreshing||loading} onClick={()=>void refresh()}><RefreshCw className={refreshing?"spin":undefined} size={15}/>{t("刷新")}</button></div>
      {failed&&<p className="usage-error" role="status">{t("用量读取失败，请稍后重试。")}</p>}
      <p className="usage-unit-key">{t("用量单位：tokens")}</p>
      <div className="usage-overview-cards">
        <article><span>{t("周额度剩余")}</span><strong>{weekly.length===1?t("{0}%",weekly[0].window.remainingPercent):"—"}</strong><small>{weekly.length===1&&weekly[0].window.resetsAt?t("重置于 {0}",date(new Date(weekly[0].window.resetsAt*1000).toISOString())):provider==="codex"||provider==="claude"?t("等待额度上报"):t("{0} 未上报周额度窗口",providerName(provider))}</small></article>
        <article><span>{t("点数余额")}</span><strong>{provider==="codex"&&accountCredits?creditText(accountCredits):"—"}</strong><small>{provider==="codex"&&!accountCredits?t("等待额度上报"):provider!=="codex"?t("点数仅由 Codex 上报"):null}</small></article>
        <article><span>{t("累计")}</span><strong>{number(data?.recorded?.totalTokens)}</strong></article>
        <article><span>{t("本周")}</span><strong>{number(data?.quotaCycle?.recordedTokens)}{data?.quotaCycle?.boundaryIncomplete&&<sup aria-label={t("数据不完整")}>*</sup>}</strong></article>
        <article><span>{t("缓存命中")}</span><strong>{percent(weeklyRate)}</strong></article>
      </div>
      <div className="usage-section-head"><div><h2>{t("项目消耗")}</h2></div></div>{rows(data?.projects,false,projectPage,setProjectPage)}
      <div className="usage-section-head"><div><h2>{t("会话消耗")}</h2></div></div>{rows(data?.sessions,true,sessionPage,setSessionPage)}
      {data?.quotaCycle?.boundaryIncomplete&&<p className="usage-data-note" role="status">{t("跨越重置时刻且无法精确拆分的用量未计入本轮。")}</p>}
      {!!data?.discontinuities&&<p className="usage-data-note" role="status">{t("检测到计数不连续，缺失区间未估算。")}</p>}
      <details className="usage-basis"><summary>{t("统计说明")}</summary>
        <p>{t("本周按账号上报的周额度重置周期计算。旧记录缺少分项时，周命中率显示为未记录。")}</p>
        {data?.quotaCycle&&<p>{t("当前周额度周期：{0} 至 {1}",date(data.quotaCycle.startsAt),date(data.quotaCycle.resetsAt))}</p>}
        <p>{t("本轮按下次周额度重置时间倒推 7 天计算，仅包含已记录用量，不等于账号官方额度消耗。缓存和推理明细不能再次加到总量。")}</p>
        <p>{t("缓存输入 ÷ 输入 token")}</p><p>{t("按本周消耗从高到低排列")}</p>
        {data&&<p>{t("已获取 {0} / {1} 个会话",data.observedSessions,data.totalSessions)}</p>}
      </details>
    </>}
  </section>;
}
