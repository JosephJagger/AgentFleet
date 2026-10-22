import type { FleetSession, Project } from './types';
import { t } from '../i18n';
export const pathName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
export const isWorktree = (project: Project) => Boolean(project.repoRoot && project.repoRoot !== project.pathHint);
export function worktreeName(project: Pick<Project, "alias" | "repoRoot">, parent?: Pick<Project, "alias">) {
  const prefix = `${parent?.alias ?? (project.repoRoot ? pathName(project.repoRoot) : '')}-`;
  return project.alias.startsWith(prefix) ? project.alias.slice(prefix.length) : project.alias;
}
export function projectFamilies(projects: Project[]) {
  const byId = new Map(projects.map(p=>[p.id,p]));
  const roots = projects.filter(p=>!p.parentProjectId || !byId.has(p.parentProjectId));
  return roots.map(project=>({ project, worktrees: projects.filter(p=>p.parentProjectId===project.id && p.id!==project.id) }));
}
export function sessionLocation(session: FleetSession) {
  if (!session.projectPath) return session.projectAlias;
  if (session.projectRepoRoot && session.projectRepoRoot !== session.projectPath) {
    const root = session.projectRootAlias || pathName(session.projectRepoRoot);
    const name = worktreeName({ alias: session.projectAlias, repoRoot: session.projectRepoRoot }, {alias:root});
    return `${root} › ${t('工作树')} ${name}${session.projectBranch ? ` · ${session.projectBranch}` : ''}`;
  }
  return `${session.projectAlias} › ${t('主目录')}`;
}
