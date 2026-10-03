import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_DEVOPS_ACCESS,
  type DevOpsAccess,
  devopsBriefOutcomes,
  type ShiftBrief,
  uuidv7,
} from '@aom/shared';
import { makeShiftStart } from './fixtures.ts';
import { sh, tmp } from './helpers.ts';

export interface VaultFixture {
  root: string;
  /** Bare origin (what the site stores as the vault URL). */
  origin: string;
  /** Another machine's clone: edits made here arrive at the runner by sync. */
  other: string;
  /** Where the runner's managed clone will live. */
  mine: string;
}

export const IDENTITY = { name: 'Atlas (aom)', email: 'atlas@agents.aom.invalid' };

/** Bare origin with one seeded commit on main, plus a second clone ("another workstation"). */
export function makeVault(seed: Record<string, string> = { 'README.md': '# vault\n' }): VaultFixture {
  const root = tmp('aom-m3-vault-');
  const origin = join(root, 'origin.git');
  const other = join(root, 'other');
  sh(root, 'git', ['init', '--bare', '-b', 'main', origin]);
  sh(root, 'git', ['clone', origin, other]);
  sh(other, 'git', ['checkout', '-b', 'main']);
  for (const [path, content] of Object.entries(seed)) {
    mkdirSync(join(other, path, '..'), { recursive: true });
    writeFileSync(join(other, path), content);
  }
  sh(other, 'git', ['add', '-A']);
  sh(other, 'git', ['commit', '-m', 'seed']);
  sh(other, 'git', ['push', '-u', 'origin', 'main']);
  return { root, origin, other, mine: join(root, 'mine') };
}

/** Empty bare origin (no commits). */
export function makeEmptyOrigin(): { root: string; origin: string; mine: string } {
  const root = tmp('aom-m3-empty-');
  const origin = join(root, 'origin.git');
  sh(root, 'git', ['init', '--bare', '-b', 'main', origin]);
  return { root, origin, mine: join(root, 'mine') };
}

/** Commits and pushes a change from the "other machine". */
export function pushFromOther(v: VaultFixture, path: string, content: string, msg = `edit ${path}`): void {
  sh(v.other, 'git', ['pull', '--rebase', 'origin', 'main']); // the runner may have pushed meanwhile
  mkdirSync(join(v.other, path, '..'), { recursive: true });
  writeFileSync(join(v.other, path), content);
  sh(v.other, 'git', ['add', '-A']);
  sh(v.other, 'git', ['commit', '-m', msg]);
  sh(v.other, 'git', ['push', 'origin', 'main']);
}

export const originLog = (v: { origin: string }): string[] =>
  sh(v.origin, 'git', ['log', '--format=%an|%s', 'main']).split('\n').filter(Boolean);
/** Exact content (no trimming) of a file on the origin's main branch. */
export const originFile = (v: { origin: string }, path: string): string =>
  execFileSync('git', ['show', `main:${path}`], { cwd: v.origin, encoding: 'utf8' });

/** A `shift.start` for a DevOps request (no card, no worktree). */
export function makeDevopsStart(
  o: {
    summary?: string;
    access?: Partial<DevOpsAccess>;
    approval?: { action: string; reason: string; commands: string[]; note?: string };
    shiftId?: string;
    agentId?: string;
    agentName?: string;
    maxShiftMinutes?: number;
  } = {},
): Record<string, unknown> {
  const base = makeShiftStart({
    remoteNormalized: 'x',
    shiftId: o.shiftId,
    agentId: o.agentId,
    agentName: o.agentName ?? 'Atlas',
    maxShiftMinutes: o.maxShiftMinutes ?? 30,
  }) as { brief: ShiftBrief; agent: Record<string, unknown>; shiftId: string };
  const requestId = uuidv7();
  const brief: ShiftBrief = {
    ...base.brief,
    shift: {
      ...base.brief.shift,
      kind: 'devops',
      stage: 'devops',
      stageLabel: 'DevOps request',
      outcomes: devopsBriefOutcomes(),
    },
    card: { ...base.brief.card, id: requestId, ref: 'DEVOPS', title: o.summary ?? 'start the app' },
  };
  return {
    ...base,
    kind: 'devops',
    brief,
    worktree: null,
    agent: { ...base.agent, isDevops: true, roleKey: 'devops' },
    devops: {
      requestId,
      threadId: requestId,
      summary: o.summary ?? 'start the app',
      requestedBy: { kind: 'user', id: uuidv7(), name: 'Pieter' },
      workstationName: 'Desk',
      access: { ...DEFAULT_DEVOPS_ACCESS, ...o.access },
      ...(o.approval ? { approval: o.approval } : {}),
      history: [],
    },
    vault: null,
  };
}
