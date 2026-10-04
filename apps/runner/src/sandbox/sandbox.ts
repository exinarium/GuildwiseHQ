import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunnerPaths } from '../paths.ts';

export interface Sandbox {
  agentId: string;
  root: string;
  /** Agent HOME / USERPROFILE (.gitconfig with the agent identity, tool caches). */
  home: string;
  /** CLAUDE_CONFIG_DIR. */
  configDir: string;
  scratch: string;
  /** Private temp dir (TMPDIR/TMP/TEMP): the agent's shell and tools write here, never to the shared /tmp. */
  tmp: string;
}

export function sandboxFor(paths: RunnerPaths, agentId: string): Sandbox {
  const root = paths.agentDir(agentId);
  return {
    agentId,
    root,
    home: join(root, 'home'),
    configDir: join(root, 'claude'),
    scratch: join(root, 'scratch'),
    tmp: join(root, 'tmp'),
  };
}

export function agentEmail(agentId: string): string {
  return `${agentId}@agents.aom.invalid`;
}

/** Creates `agents/<id>/{home,claude,scratch,tmp}` and the agent's `.gitconfig` (idempotent; refreshes the name). */
export async function ensureSandbox(
  paths: RunnerPaths,
  agentId: string,
  agentName: string,
): Promise<Sandbox> {
  const sb = sandboxFor(paths, agentId);
  await Promise.all([sb.home, sb.configDir, sb.scratch, sb.tmp].map((d) => mkdir(d, { recursive: true })));
  const gitconfig = [
    '[user]',
    `\tname = ${agentName} (aom)`,
    `\temail = ${agentEmail(agentId)}`,
    '[commit]',
    '\tgpgsign = false',
    '[core]',
    '\tautocrlf = false',
    '[init]',
    '\tdefaultBranch = main',
    '',
  ].join('\n');
  await writeFile(join(sb.home, '.gitconfig'), gitconfig);
  return sb;
}

/** Environment that makes every child process (agent, git) use the agent's private home and identity. */
export function sandboxEnv(sb: Sandbox): Record<string, string> {
  return {
    HOME: sb.home,
    USERPROFILE: sb.home,
    GIT_CONFIG_GLOBAL: join(sb.home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    CLAUDE_CONFIG_DIR: sb.configDir,
    TMPDIR: sb.tmp,
    TMP: sb.tmp,
    TEMP: sb.tmp,
  };
}

/** `agent.wipe`: removes `agents/<id>` recursively. Idempotent. */
export async function wipeAgent(paths: RunnerPaths, agentId: string): Promise<{ removed: boolean }> {
  const dir = paths.agentDir(agentId);
  const existed = existsSync(dir);
  await rm(dir, { recursive: true, force: true });
  return { removed: existed };
}
