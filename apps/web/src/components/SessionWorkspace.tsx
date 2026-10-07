import { SubagentsPanel } from "./SubagentsPanel";
import { WorkspaceHistory } from "./WorkspaceHistory";
import { WorkspaceTerminal } from "./WorkspaceTerminal";
import { createPortal } from "react-dom";
import { SessionConfiguration } from "./SessionConfiguration";
import { useState } from "react";
import { FileText, Terminal, History, Plug, FolderOpen } from "lucide-react";
import { SettingsSections } from "./SettingsSections";
import { ProjectFilesPanel } from "./ProjectFilesPanel";
import { CodexOperationsPanel } from "./CodexOperationsPanel";
import { t } from "../i18n";
import type { FleetSession, CommandReceipt } from "../lib/types";

export function SessionWorkspace(props: { session: FleetSession; commands: CommandReceipt[]; onChanged: () => void }) {
  const [tab, setTab] = useState<"files" | "terminal" | "history" | "tools">("files");
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return <><button type="button" className="button button--quiet session-config-trigger" aria-label={t("项目工具")} title={t("项目工具")} aria-haspopup="dialog" onClick={() => { setOpened(true); setOpen(true); }}><FolderOpen size={18}/><span>{t("项目工具")}</span></button>
    {opened && createPortal(<SessionConfiguration request={open ? {section:"all",nonce:0} : undefined} heading={t("项目工具")} closeLabel={t("关闭项目工具")} title={`${props.session.projectAlias ?? ""} · ${props.session.machineName ?? ""}`} onClose={() => setOpen(false)}>
    <p className="project-tools-description">{t("手动查看项目文件、执行命令，或查看会话历史与子代理。日常对话直接使用消息框即可。")}</p><div className="project-tools-panel">
    <SettingsSections label={t("项目工作区分类")} value={tab} onChange={setTab} items={[
      { id: "files", label: t("文件"), icon: <FileText size={17}/> }, { id: "terminal", label: t("命令"), icon: <Terminal size={17}/> }, { id: "history", label: t("历史"), icon: <History size={17}/> }, { id: "tools", label: t("集成"), icon: <Plug size={17}/> },
    ]}/>
    <div hidden={tab !== "files"}><ProjectFilesPanel {...props}/></div>
    <div hidden={tab !== "terminal"}><WorkspaceTerminal {...props}/></div>
    {tab === "history" && <><WorkspaceHistory {...props}/><SubagentsPanel {...props}/><CodexOperationsPanel {...props} title="会话与目标" initialOperation="goal.read" groups={["session", "experimental"]}/></>}
    {tab === "tools" && <CodexOperationsPanel {...props} title="项目集成" initialOperation="mcp.catalog" groups={["integrations"]}/>}
  </div></SessionConfiguration>, document.body)}</>;
}
