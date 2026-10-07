import { SubagentsPanel } from "./SubagentsPanel";
import { WorkspaceHistory } from "./WorkspaceHistory";
import { WorkspaceTerminal } from "./WorkspaceTerminal";
import { useState } from "react";
import { FileText, Terminal, History, Plug } from "lucide-react";
import { SettingsSections } from "./SettingsSections";
import { ProjectFilesPanel } from "./ProjectFilesPanel";
import { CodexOperationsPanel } from "./CodexOperationsPanel";
import { t } from "../i18n";
import type { FleetSession, CommandReceipt } from "../lib/types";

export function SessionWorkspace(props: { session: FleetSession; commands: CommandReceipt[]; onChanged: () => void }) {
  const [tab, setTab] = useState<"files" | "terminal" | "history" | "tools">("files");
  return <details className="session-workspace"><summary>{t("项目工作区")}<small>{t("文件、命令与会话工具")}</small></summary><div className="session-workspace__body">
    <SettingsSections label={t("项目工作区分类")} value={tab} onChange={setTab} items={[
      { id: "files", label: t("文件"), icon: <FileText size={17}/> }, { id: "terminal", label: t("命令"), icon: <Terminal size={17}/> }, { id: "history", label: t("历史"), icon: <History size={17}/> }, { id: "tools", label: t("集成"), icon: <Plug size={17}/> },
    ]}/>
    <div hidden={tab !== "files"}><ProjectFilesPanel {...props}/></div>
    <div hidden={tab !== "terminal"}><WorkspaceTerminal {...props}/></div>
    {tab === "history" && <><WorkspaceHistory {...props}/><SubagentsPanel {...props}/><CodexOperationsPanel {...props} title="会话与目标" initialOperation="goal.read" groups={["session", "experimental"]}/></>}
    {tab === "tools" && <CodexOperationsPanel {...props} title="项目集成" initialOperation="mcp.catalog" groups={["integrations"]}/>}
  </div></details>;
}
