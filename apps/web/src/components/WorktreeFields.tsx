import { useId } from "react";
import { t } from "../i18n";
import type { WorktreeOverview } from "../lib/types";

export interface WorktreeDraft { base: string; branch: string; setup: boolean }
export function worktreeBranchError(overview: WorktreeOverview, branch: string): string {
  const value = branch.trim();
  if (!value) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) || value === "HEAD" || value.includes("..") || value.includes("//") || value.endsWith("/") || value.split("/").some(part => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) return t("请输入有效的新分支名称，例如 feat/login-fix");
  if (overview.branches.includes(value)) return t("这个分支已经存在，请为新工作树换一个名称");
  if (!overview.customBranchNames && !/^af\/[a-z0-9][a-z0-9._-]{0,47}$/.test(value)) return t("此主机目前仅支持 af/ 开头的简单分支名；更新连接服务后可使用任意有效分支名");
  return "";
}
/** Older hosts accept an af/ suffix as their directory name; never silently ignore a custom branch. */
export function worktreeBranchInput(overview: WorktreeOverview, branch: string) {
  const value = branch.trim();
  const error = worktreeBranchError(overview, value);
  if (error) throw new Error(error);
  return !value ? {} : overview.customBranchNames ? { branch: value } : { name: value.slice(3) };
}
export function WorktreeFields({ overview, value, onChange, disabled = false }: { overview: WorktreeOverview; value: WorktreeDraft; onChange: (value: WorktreeDraft) => void; disabled?: boolean }) {
  const id = useId(), error = worktreeBranchError(overview, value.branch);
  return <div className="worktree-fields">
    <label><span>{t("基础分支")}</span><select disabled={disabled} value={value.base} onChange={e => onChange({ ...value, base: e.target.value })}>{overview.branches.map(branch => <option key={branch} value={branch}>{branch}</option>)}</select><small>{t("从这个已有分支的已提交代码开始，不会修改它。")}</small></label>
    <label><span>{t("新分支名称（可选）")}</span><input disabled={disabled} value={value.branch} maxLength={200} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={overview.customBranchNames ? "feat/login-fix" : "af/login-fix"} aria-invalid={Boolean(error)} aria-describedby={`${id}-branch`} onChange={e => onChange({ ...value, branch: e.target.value })} />
      <small id={`${id}-branch`} className={error ? "catalog-error" : ""}>{error || (value.branch.trim() ? t("将创建新分支：{0}", value.branch.trim()) : t("留空则自动生成 af/ 开头的新分支名称。"))}</small></label>
    <details className="worktree-environment"><summary>{t("初始化环境（可选）")} · {overview.setupScript ? value.setup ? t("已启用") : t("不运行") : t("未配置，可直接创建")}</summary>
      {overview.setupScript ? <label className="checkbox-row"><input type="checkbox" disabled={disabled} checked={value.setup} onChange={e => onChange({ ...value, setup: e.target.checked })} /><span>{t("创建后运行项目的初始化脚本")}</span></label> : <p>{t("未配置初始化脚本，可直接创建工作树。需要时可在新会话中安装依赖。")}</p>}
      <small>{t("脚本位置：.agentfleet/worktree-setup.sh。用于安装依赖等环境准备，不会选择或更换智能体模型。")}</small>
    </details>
  </div>;
}
