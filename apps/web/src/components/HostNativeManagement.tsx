import { BedrockPanel } from "./BedrockPanel";
import { NativeImportPanel } from "./NativeImportPanel";
import { SkillRootsPanel } from "./SkillRootsPanel";
import { SettingsSections } from "./SettingsSections";
import { User, Plug, Server, FlaskConical } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { t, systemText } from "../i18n";
import type { Machine, HostOperation } from "../lib/types";
import { CodexOperationsPanel } from "./CodexOperationsPanel";
export function HostNativeManagement({ machine }: { machine: Machine }) {
  const [section, setSection] = useState<"account" | "integrations" | "environment" | "experimental">("account");
  const [operations, setOperations] = useState<HostOperation[]>([]);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const next = await api.hostOperations(machine.id, controller.signal); if (!controller.signal.aborted) { setOperations(next); setError(""); } }
      catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 4000); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [machine.id, reload]);
  return <div><h3>{t("主机账号与原生环境")}</h3><p>{t("直接管理所选主机的账号、额度、插件和原生环境，无需选择或创建会话。变更仅影响此主机，不会同步账号到其他主机。")}</p>
    <SettingsSections label={t("主机原生管理分类")} value={section} onChange={setSection} items={[
      {id:"account",label:t("账号与额度"),icon:<User size={17}/>}, {id:"integrations",label:t("插件与连接"),icon:<Plug size={17}/>}, {id:"environment",label:t("运行环境"),icon:<Server size={17}/>}, {id:"experimental",label:t("实验功能"),icon:<FlaskConical size={17}/>},
    ]}/>
    {section === "account" && <BedrockPanel machine={machine} hostOperations={operations} onChanged={() => setReload(n => n + 1)}/>}
    {section === "integrations" && <SkillRootsPanel machine={machine} hostOperations={operations} onChanged={() => setReload(n => n + 1)}/>}
    {section === "environment" && <NativeImportPanel machine={machine} hostOperations={operations} onChanged={() => setReload(n => n + 1)}/>}
    {error ? <p role="alert">{systemText(error)}</p> : <CodexOperationsPanel key={section} machine={machine} hostOperations={operations} groups={[section]} title={{account:"账号与额度",integrations:"插件与连接",environment:"运行环境",experimental:"实验功能"}[section]} initialOperation={{account:"account.read",integrations:"plugin.catalog",environment:"provider.read",experimental:"memory.status"}[section] as "account.read" | "plugin.catalog" | "provider.read" | "memory.status"} onChanged={() => setReload(n => n + 1)} />}
  </div>;
}
