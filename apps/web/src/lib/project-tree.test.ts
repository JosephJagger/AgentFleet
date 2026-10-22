import { expect, it } from 'vitest';
import { sessionLocation } from './project-tree';
import type { FleetSession } from './types';

it('session locations distinguish main directories, worktrees and legacy metadata without inventing a branch', () => {
  const session = { projectAlias: 'HeraLens', projectPath: '/opt/HeraLens' } as FleetSession;
  expect(sessionLocation(session)).toBe('HeraLens › 主目录');
  expect(sessionLocation({ ...session, projectRepoRoot: session.projectPath })).toBe('HeraLens › 主目录');
  const lane = { ...session, projectAlias: 'HeraLens-seo-da3f', projectPath: '/opt/.HeraLens.worktrees/seo-da3f', projectRepoRoot: '/opt/HeraLens', projectRootAlias: 'HeraLens', projectBranch: 'feat/seo' };
  expect(sessionLocation(lane)).toBe('HeraLens › 工作树 seo-da3f · feat/seo');
  expect(sessionLocation({ ...lane, projectBranch: null })).toBe('HeraLens › 工作树 seo-da3f');
  expect(sessionLocation({ ...session, projectPath: undefined })).toBe('HeraLens');
});
