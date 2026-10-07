import { useEffect, useRef, useState } from "react";
import stripAnsi from "strip-ansi";
import { t, systemText } from "../i18n";
import type { FleetSession, CommandReceipt } from "../lib/types";
import { useCodexOperation } from "./useCodexOperation";

export function WorkspaceTerminal(props: { session: FleetSession; commands: CommandReceipt[]; onChanged: () => void }) {
  const op = useCodexOperation(props);
  const [command, setCommand] = useState("git status --short");
  const [cols, setCols] = useState(80);
  const [processId, setProcessId] = useState("");
  const [output, setOutput] = useState("");
  const [exitCode, setExitCode] = useState("");
  const [outputNotice, setOutputNotice] = useState("");
  const [input, setInput] = useState("");
  const [state, setState] = useState("");
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const applied = useRef<string | undefined>(undefined);
  const running = ["starting", "running"].includes(state);
  useEffect(() => {
    if (!op.result || !op.id || op.id === applied.current) return; applied.current = op.id;
    const result = op.result;
    setProcessId(result.rows.find(r => r.name === "processId")?.detail ?? "");
    setOutput(stripAnsi(result.rows.filter(r => r.name.startsWith("output:")).map(r => r.detail).join("")));
    setState(result.status);
    setExitCode(result.rows.find(r => r.name === "exitCode")?.detail ?? "");
    setOutputNotice(result.rows.find(r => r.name === "exitCode")?.status ?? "");
  }, [op.result, op.id]);
  useEffect(() => {
    if (!running || !processId || op.pending || !op.allowed || op.error) return;
    const timer = setTimeout(() => void op.run("terminal.status", { processId }), 2500);
    return () => clearTimeout(timer);
  }, [running, processId, op.pending, op.allowed, op.id, op.error]);
  async function start() {
    setError(""); await op.run("terminal.start", { command, confirmed: true });
  }

  return <section className="stack-form"><h3>{t("项目终端")}</h3><p>{t("命令在本会话目录运行，沿用执行权限。支持输入与中止，最长运行 2 分钟；主机连接断开会结束命令。")}</p>
    <label>{t("要执行的命令")}<textarea value={command} disabled={running || op.pending} onChange={e => { setCommand(e.target.value); setConfirmed(false); }}/></label>
    <label className="checkbox-row"><input type="checkbox" checked={confirmed} disabled={running || op.pending} onChange={e => setConfirmed(e.target.checked)}/>{t("确认在此项目执行命令")}</label>
    <button type="button" className="button button--primary" disabled={!op.allowed || op.pending || running || !confirmed || !command.trim()} onClick={() => void start()}>{t("运行命令")}</button>
    {processId && <><p role="status">{t(running ? "命令运行中" : state === "completed" ? "命令已结束" : "命令连接失败")}</p>{exitCode && <p>{t("退出码")}: {exitCode}</p>}{outputNotice && <small>{systemText(outputNotice)}</small>}<pre className="workspace-terminal-output" aria-label={t("终端输出")}>{output || t("暂无输出")}</pre>
      <label>{t("终端宽度")}<select value={cols} disabled={!running || op.pending} onChange={e => { setCols(Number(e.target.value)); void op.run("terminal.resize", { processId, rows: 24, cols: Number(e.target.value), confirmed: true }); }}>{[60,80,120].map(n => <option key={n} value={n}>{n} {t("列")}</option>)}</select></label>
      <label>{t("发送到终端")}<input value={input} disabled={!running || op.pending} onChange={e => setInput(e.target.value)}/></label>
      <div className="workspace-actions"><button type="button" className="button button--quiet" disabled={!running || op.pending || !op.allowed} onClick={() => { void op.run("terminal.write", { processId, text: input + "\n", confirmed: true }); setInput(""); }}>{t("发送输入")}</button><button type="button" className="button button--quiet" disabled={!running || op.pending || !op.allowed} onClick={() => void op.run("terminal.stop", { processId, confirmed: true })}>{t("结束命令")}</button><button type="button" className="button button--quiet" disabled={op.pending || !op.allowed} onClick={() => void op.run("terminal.status", { processId })}>{t("刷新输出")}</button></div></>}
    {(error || op.error) && <p role="alert">{systemText(error || op.error)}</p>}
  </section>;
}
