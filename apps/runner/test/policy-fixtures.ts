import type { ClaudePolicyContext } from '../src/adapters/claude-policy.ts';

export const POLICY_PATHS = {
  home: '/data/agents/a1/home',
  configDir: '/data/agents/a1/claude',
  scratch: '/data/agents/a1/scratch',
};
export const policyCtx = (over: Partial<ClaudePolicyContext> = {}): ClaudePolicyContext => ({
  runnerRoot: '/data',
  agentDir: '/data/agents/a1',
  cwd: '/data/worktrees/TOY-0192abcd/TOY-1',
  addDirs: [],
  gitDirs: ['/home/me/toy/.git'],
  aomReadPaths: ['/data/bin'],
  realHome: '/home/me',
  mode: 'required',
  ...over,
});
