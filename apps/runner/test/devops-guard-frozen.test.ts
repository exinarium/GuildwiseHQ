import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { ClaudeCodeAdapter, GUARD_DIR, guardFileFor } from '../src/adapters/claude-code.ts';
import {
  auditEntry,
  classifyCommand,
  deleteRootsFor,
  type GuardConfig,
  type GuardDeps,
  loadGuardConfig,
  runGuardHook,
} from '../src/devops/guard.ts';
import { runnerPaths } from '../src/paths.ts';
import { tmp } from './helpers.ts';

const ROOT = '/home/u/.aom-runner';
const B = 'release/1.6.0';
const prepCfg = (over: Partial<GuardConfig> = {}): GuardConfig => ({
  sessionRef: 'shift-9',
  kind: 'shift',
  shiftKind: 'release_prep',
  deleteRoots: deleteRootsFor(ROOT, '/tmp'),
  home: '/home/u',
  protectedBranches: [B],
  frozenBranches: [B],
  approvedCommands: [],
  ...over,
});
const devopsCfg = (): GuardConfig => ({
  sessionRef: 'shift-1',
  kind: 'shift',
  shiftKind: 'devops',
  deleteRoots: deleteRootsFor(ROOT, '/tmp'),
  home: '/home/u',
  protectedBranches: [B],
  approvedCommands: ['ssh other-host'],
});
const CWD = `${ROOT}/worktrees/release-prep-ab12cd34`;
const head = (b: string | null | 'unknown'): GuardDeps => ({ headBranch: () => b });
const verdict = (cmd: string, deps: GuardDeps = head(null), cfg = prepCfg()) =>
  classifyCommand(cmd, cfg, CWD, deps);

describe('frozen release branch (release prep guard)', () => {
  it.each([
    `git push origin ${B}`,
    `git push -f origin ${B}`,
    `git push origin :${B}`,
    `git push origin HEAD:refs/heads/${B}`,
    'git push',
    'git push origin',
    'git push origin HEAD',
    'git push --all origin',
    `git branch -D ${B}`,
    `git branch -f ${B} abc123`,
    `git branch -m ${B} other`,
    `git update-ref -d refs/heads/${B}`,
    `git checkout ${B}`,
    `git switch ${B}`,
    `git checkout -B ${B}`,
    `git worktree add /tmp/x ${B}`,
  ])('refuses %s', (cmd) => {
    const v = verdict(cmd);
    expect(v.decision).toBe('refused');
    expect(['frozen_branch', 'force_push_protected']).toContain(v.rule);
  });

  it('uses one refusal text for the frozen rule', () => {
    const v = verdict(`git push origin ${B}`);
    expect(v.rule).toBe('frozen_branch');
    expect(v.reason).toContain(`Branch "${B}" is the release branch of this release prep`);
    expect(v.reason).toContain('aom prep done');
  });

  it('refuses a reset or commit when the checked-out branch is frozen or unknown', () => {
    expect(verdict('git reset --hard abc', head(B)).rule).toBe('frozen_branch');
    expect(verdict('git reset --hard abc', head('unknown')).rule).toBe('frozen_branch');
    expect(verdict('git commit -m x', head(B)).rule).toBe('frozen_branch');
    expect(verdict('git -C /x/y rebase main', head('unknown')).rule).toBe('frozen_branch');
    expect(verdict('git --git-dir=/x reset --hard abc', head(null)).rule).toBe('frozen_branch');
    // no lookup injected: unknown
    expect(classifyCommand('git commit -m x', prepCfg(), CWD).rule).toBe('frozen_branch');
  });

  it.each([
    'git status',
    'git log --oneline',
    'git add docs/a.md',
    'git commit -m x',
    'git reset --hard abc',
    'git reset HEAD docs/a.md',
    'git reset -- docs/a.md',
    'git checkout -- docs/a.md',
    `git checkout ${B} -- docs/a.md`,
    `git checkout -b docs/new ${B}`,
    `git push origin docs/other`,
    'git branch -D scratch',
    'pnpm build',
  ])('allows %s in a detached worktree', (cmd) => {
    expect(verdict(cmd, head(null)).decision).toBe('allowed');
  });

  it('allows a commit on a branch that is not frozen', () => {
    expect(verdict('git commit -m x', head('docs/other')).decision).toBe('allowed');
  });

  it('looks up the directory after cd and -C', () => {
    const seen: string[] = [];
    const deps: GuardDeps = { headBranch: (d) => (seen.push(d), null) };
    verdict('cd /work/tree && git commit -m x', deps);
    verdict('git -C sub reset --hard x', deps);
    expect(seen).toEqual(['/work/tree', `${CWD}/sub`]);
  });

  it('refuses off-workstation commands, deletes outside the roots and ignores devops approvals', () => {
    const ssh = verdict('ssh other-host', head(null), prepCfg({ approvedCommands: [] }));
    expect(ssh).toMatchObject({ decision: 'refused', rule: 'off_workstation' });
    const devops = classifyCommand('ssh other-host', devopsCfg(), CWD);
    expect(devops.rule).toBe('off_workstation_approved');
    expect(verdict('rm -rf /home/x/elsewhere').decision).toBe('refused');
  });

  it('leaves devops shifts and chats alone: no frozen rule, no git lookup', () => {
    let called = 0;
    const deps: GuardDeps = { headBranch: () => (called++, B) };
    for (const cmd of [`git push origin ${B}`, 'git push origin dev-working', 'git commit -m x', 'git reset --hard x'])
      expect(classifyCommand(cmd, devopsCfg(), CWD, deps).decision).toBe('allowed');
    expect(called).toBe(0);
  });
});

describe('audit entries and the hook of a release prep shift', () => {
  it('tags the entry with the shift id and shift kind', () => {
    const e = auditEntry(prepCfg(), 'git status', { decision: 'allowed', rule: 'ok' }, new Date(0));
    expect(e).toMatchObject({ sessionRef: 'shift-9', kind: 'shift', shiftKind: 'release_prep' });
    const chat = auditEntry(
      { sessionRef: 'c1', kind: 'chat' },
      'ls',
      { decision: 'allowed', rule: 'ok' },
      new Date(0),
    );
    expect('shiftKind' in chat).toBe(false);
  });

  it('records a decision for the first Bash command and refuses the frozen branch', async () => {
    const t = tmp();
    const file = join(t, 'g.json');
    writeFileSync(file, JSON.stringify(prepCfg()));
    const cfg = loadGuardConfig(file);
    expect(cfg.frozenBranches).toEqual([B]);
    const sent: unknown[] = [];
    const run = (command: string) =>
      runGuardHook({
        stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: CWD }),
        cfg,
        deps: head(null),
        report: async (e) => (sent.push(...e), true),
      });
    expect((await run('git status')).stdout).toBe('');
    expect((await run(`git push origin ${B}`)).stdout).toContain('frozen_branch');
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ sessionRef: 'shift-9', shiftKind: 'release_prep', decision: 'allowed' });
    expect(sent[1]).toMatchObject({ decision: 'refused', rule: 'frozen_branch' });
  });
});

describe('guard file per session', () => {
  it('names one file per kind and session ref, hashing unsafe refs', () => {
    expect(guardFileFor('/cfg', 'shift', 'abc-123')).toBe('/cfg/devops-guard/shift-abc-123.json');
    expect(guardFileFor('/cfg', 'chat', 'abc-123')).toBe('/cfg/devops-guard/chat-abc-123.json');
    const odd = guardFileFor('/cfg', 'shift', '../../etc/x');
    expect(odd).toMatch(/^\/cfg\/devops-guard\/shift-[0-9a-f]{32}\.json$/);
  });

  it('writes separate files for a release prep shift, a devops shift and a chat of one agent', () => {
    const t = tmp();
    const adapter = new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse({}), runnerPaths(t));
    const dir = join(t, 'agents', 'a1', 'claude');
    mkdirSync(dir, { recursive: true });
    const guard = (adapter as unknown as {
      devopsGuard: (d: string, g: object, k: 'shift' | 'chat') => { file: string } | undefined;
    }).devopsGuard.bind(adapter);
    const a = guard(dir, { sessionRef: 'p1', shiftKind: 'release_prep', protectedBranches: [B], frozenBranches: [B], approvedCommands: [] }, 'shift');
    const b = guard(dir, { sessionRef: 'd1', shiftKind: 'devops', protectedBranches: ['main'], approvedCommands: ['ssh x'] }, 'shift');
    const c = guard(dir, { sessionRef: 'c1', protectedBranches: ['main'], approvedCommands: ['ssh y'] }, 'chat');
    expect(new Set([a?.file, b?.file, c?.file]).size).toBe(3);
    const read = (f?: string) => JSON.parse(readFileSync(f as string, 'utf8'));
    expect(read(a?.file)).toMatchObject({ shiftKind: 'release_prep', frozenBranches: [B], approvedCommands: [] });
    expect(read(b?.file)).toMatchObject({ shiftKind: 'devops', frozenBranches: [], approvedCommands: ['ssh x'] });
    expect(read(c?.file)).toMatchObject({ kind: 'chat', approvedCommands: ['ssh y'] });
    expect(a?.file).toContain(`/${GUARD_DIR}/`);
  });

  it('prunes guard files and the legacy shared file once they are over a day old', () => {
    const t = tmp();
    const adapter = new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse({}), runnerPaths(t));
    const dir = join(t, 'agents', 'a1', 'claude');
    mkdirSync(join(dir, GUARD_DIR), { recursive: true });
    const oldFile = join(dir, GUARD_DIR, 'shift-old.json');
    const legacy = join(dir, 'devops-guard.json');
    for (const f of [oldFile, legacy]) {
      writeFileSync(f, '{}');
      utimesSync(f, new Date(0), new Date(0));
    }
    const fresh = join(dir, GUARD_DIR, 'shift-fresh.json');
    writeFileSync(fresh, '{}');
    (adapter as unknown as { devopsGuard: (d: string, g: object, k: string) => unknown }).devopsGuard(
      dir,
      { sessionRef: 'n1', approvedCommands: [] },
      'shift',
    );
    const gone = (f: string) => {
      try {
        readFileSync(f);
        return false;
      } catch {
        return true;
      }
    };
    expect(gone(oldFile)).toBe(true);
    expect(gone(legacy)).toBe(true);
    expect(gone(fresh)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
