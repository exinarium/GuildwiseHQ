import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CommitAs, NO_COMMIT_IDENTITY_MESSAGE } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { saveUncommittedWork } from '../src/devops/saved-work.ts';
import { executeCompletion } from '../src/git/completion.ts';
import { RebaseConflictError, rebaseOntoBase } from '../src/git/rebase.ts';
import { mergeMainIntoCard, syncMainIntoWorking } from '../src/git/sync-main.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { syncVault } from '../src/vaults/sync.ts';
import { type Harness, startHarness, worktreeOf } from './harness.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();

/*
 * Invisible organisation (backlog #65): scan every commit the runner makes in these tests for anything that would tell a
 * client that agents, AI or the product were involved, in the author, the committer and the message.
 */
const FORBIDDEN =
  /aom\b|guildwise|\.invalid|\bagents?\b|claude|anthropic|co-authored-by|generated (by|with)|\(aom\)|noreply@anthropic|\bAda\b|leftovers|\bshift\b/i;

function scanCommits(repoDir: string): void {
  const out = execFileSync('git', ['log', '--all', '--format=%an|%ae|%cn|%ce|%B%x00'], {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env },
  });
  for (const c of out.split('\0').filter((x) => x.trim())) {
    const [an, ae, cn, ce, ...msg] = c.trim().split('|');
    for (const field of [an, ae, cn, ce, msg.join('|')]) expect(field, `commit: ${c}`).not.toMatch(FORBIDDEN);
  }
}

const OWNER = { name: 'Workstation Owner', email: 'owner@example.test' };
const PROJECT: CommitAs = { name: 'Pieter Jordaan', email: 'pieter@example.test' };
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
let h: Harness | undefined;
afterEach(async () => {
  process.env.GIT_CONFIG_GLOBAL = savedGlobal as string;
  await h?.stop();
  h = undefined;
});

function noGlobalIdentity(): void {
  const f = join(mkdtempSync(join(tmpdir(), 'aom-noid-')), 'gitconfig');
  writeFileSync(f, '');
  process.env.GIT_CONFIG_GLOBAL = f;
}

const who = (dir: string, rev = 'HEAD') =>
  sh(dir, 'git', ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', rev]);

describe('shifts commit as the owner', () => {
  it('uses the project "Commit as" for the agent, the leftovers commit and the sandbox; nothing names an agent', async () => {
    let wt = '';
    const seenEnv: Record<string, string> = {};
    const adapter = new ScriptedAdapter(async (i, ctl) => {
      wt = i.cwd;
      for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'])
        seenEnv[k] = i.env[k] as string;
      writeFileSync(join(wt, 'agent-work.ts'), 'a\n');
      sh(wt, 'git', ['add', '-A']);
      execFileSync('git', ['commit', '-m', 'Add the greeting'], {
        cwd: wt,
        env: { ...process.env, ...i.env },
      });
      writeFileSync(join(wt, 'left-over.ts'), 'l\n');
      await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'n', data: {} },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    await h.runShift({ stage: 'build', agentName: 'Ada', startExtra: { commitAs: PROJECT } });
    expect(seenEnv).toEqual({
      GIT_AUTHOR_NAME: PROJECT.name,
      GIT_AUTHOR_EMAIL: PROJECT.email,
      GIT_COMMITTER_NAME: PROJECT.name,
      GIT_COMMITTER_EMAIL: PROJECT.email,
    });
    const wtDir = worktreeOf(h);
    expect(wtDir).toBe(wt);
    expect(sh(wt, 'git', ['log', '-2', '--format=%an <%ae>|%cn <%ce>|%s'])).toBe(
      'Pieter Jordaan <pieter@example.test>|Pieter Jordaan <pieter@example.test>|Work in progress\n' +
        'Pieter Jordaan <pieter@example.test>|Pieter Jordaan <pieter@example.test>|Add the greeting',
    );
    scanCommits(wt);
  });

  it('without a project setting the workstation global identity is used', async () => {
    const adapter = new ScriptedAdapter(async (i) => {
      writeFileSync(join(i.cwd, 'x.ts'), 'x\n');
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    await h.runShift({ stage: 'build' });
    expect(who(worktreeOf(h))).toBe(
      `${OWNER.name} <${OWNER.email}>|${OWNER.name} <${OWNER.email}>|Work in progress`,
    );
  });

  it('the ticket key the card came from is the only reference in the message', async () => {
    const adapter = new ScriptedAdapter(async (i) => {
      writeFileSync(join(i.cwd, 'x.ts'), 'x\n');
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    await h.runShift({ stage: 'build', fields: { externalRef: 'DCPL-4276' } });
    expect(who(worktreeOf(h))).toMatch(/\|DCPL-4276: Work in progress$/);
  });

  it('refuses the shift when no identity is set anywhere, with the message naming the three places', async () => {
    noGlobalIdentity();
    let ran = false;
    const adapter = new ScriptedAdapter(async () => {
      ran = true;
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const msg = h.server.of('shift.rejected');
    const before = msg.length;
    h.server.send(
      'shift.start',
      (await import('./fixtures.ts')).makeShiftStart({
        stage: 'build',
        remoteNormalized: h.repo.remoteNormalized,
      }),
    );
    await h.server.waitFor('shift.rejected', () => true, 20_000);
    const rejected = h.server.of('shift.rejected');
    expect(rejected.length).toBe(before + 1);
    expect(rejected[rejected.length - 1]).toMatchObject({ reason: 'internal' });
    expect(rejected[rejected.length - 1]?.detail).toContain(NO_COMMIT_IDENTITY_MESSAGE);
    expect(rejected[rejected.length - 1]?.detail).toMatch(/^no_commit_identity:/);
    expect(ran).toBe(false);
  });

  it('a read-only shift (a read-only checkout) is not refused for a missing identity', async () => {
    noGlobalIdentity();
    let ran = 0;
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      ran += 1;
      await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'n', data: {} },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    await h.runShift({ stage: 'investigate', mode: 'readonly' });
    expect(ran).toBe(1);
    expect(h.server.of('shift.rejected').map((m) => m.detail)).not.toContainEqual(
      expect.stringContaining('no_commit_identity'),
    );
  });
});

describe('runner-made git operations use the resolver', () => {
  it('finalize merge: the merge commit carries the project identity, the title names no card ref', async () => {
    const repo = makeRepo();
    const wt = join(tmp(), 'wt');
    await ensureWorktree({
      repoPath: repo.clone,
      spec: {
        mode: 'create',
        repoId: 'r',
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'main',
        branchName: 'card-x',
      },
      defaultPath: wt,
      roots: [join(wt, '..')],
    } as never);
    writeFileSync(join(wt, 'thing.txt'), 'thing\n');
    sh(wt, 'git', ['add', '-A']);
    sh(wt, 'git', ['commit', '-m', 'Add thing']);
    const payload = {
      cardId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      ref: 'P4-12',
      title: 'Add thing',
      projectKey: 'TOY',
      action: 'merge',
      repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2',
      remoteUrlNormalized: repo.remoteNormalized,
      baseBranch: 'main',
      branchName: 'card-x',
      worktreePath: wt,
      ticket: 'DCPL-4276',
      commitAs: PROJECT,
    } as const;
    const res = await executeCompletion({
      payload: payload as never,
      repoPath: repo.clone,
      worktreePath: wt,
      worktreesDir: join(wt, '..'),
      integrationDir: tmp(),
      pr: { create: async () => ({ url: 'x' }) } as never,
    });
    expect(res.ok).toBe(true);
    expect(who(repo.origin, 'main')).toBe(
      'Pieter Jordaan <pieter@example.test>|Pieter Jordaan <pieter@example.test>|Merge DCPL-4276: Add thing',
    );
    scanCommits(repo.origin);
  });

  it('finalize merge is refused without any identity and nothing is merged', async () => {
    const repo = makeRepo();
    const wt = join(tmp(), 'wt');
    sh(repo.clone, 'git', ['worktree', 'add', '-b', 'card-y', wt]);
    writeFileSync(join(wt, 'y.txt'), 'y\n');
    sh(wt, 'git', ['add', '-A']);
    sh(wt, 'git', ['commit', '-m', 'Add y']);
    noGlobalIdentity();
    const res = await executeCompletion({
      payload: {
        cardId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        ref: 'TOY-1',
        title: 'Add y',
        projectKey: 'TOY',
        action: 'merge',
        repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2',
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'main',
        branchName: 'card-y',
        worktreePath: wt,
      } as never,
      repoPath: repo.clone,
      worktreePath: wt,
      worktreesDir: join(wt, '..'),
      integrationDir: tmp(),
      pr: { create: async () => ({ url: 'x' }) } as never,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe(NO_COMMIT_IDENTITY_MESSAGE);
    expect(sh(repo.origin, 'git', ['log', '-1', '--format=%s', 'main'])).not.toMatch(/Merge/);
  });

  it('sync-main merge into the working branch and into the card use the project identity', async () => {
    const repo = makeRepo();
    // main moves on origin, the working branch is separate
    sh(repo.clone, 'git', ['push', 'origin', 'main:work']);
    writeFileSync(join(repo.clone, 'main-change.txt'), 'm\n');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'Change main']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const out = await syncMainIntoWorking({
      repoPath: repo.clone,
      mainBranch: 'main',
      workingBranch: 'work',
      ref: 'TOY-1',
      integrationDir: tmp(),
      commitAs: PROJECT,
    });
    expect(out.kind).toBe('merged_into_working');
    expect(who(repo.origin, 'work')).toBe(
      'Pieter Jordaan <pieter@example.test>|Pieter Jordaan <pieter@example.test>|Merge main into work',
    );
    // and the card-branch merge
    const wt = join(tmp(), 'wt');
    sh(repo.clone, 'git', ['worktree', 'add', '-b', 'card-z', wt, 'origin/work~1']);
    writeFileSync(join(wt, 'z.txt'), 'z\n');
    sh(wt, 'git', ['add', '-A']);
    sh(wt, 'git', ['commit', '-m', 'Add z']);
    const merged = await mergeMainIntoCard(wt, { mainBranch: 'main', ref: 'TOY-1', commitAs: PROJECT });
    expect(merged).toMatchObject({ result: 'merged_into_card' });
    expect(who(wt)).toBe(
      'Pieter Jordaan <pieter@example.test>|Pieter Jordaan <pieter@example.test>|Merge main into the card branch',
    );
    scanCommits(repo.clone);
  });

  it('rebase: the committer of the rewritten commits is the resolved identity', async () => {
    const repo = makeRepo();
    const wt = join(tmp(), 'wt');
    sh(repo.clone, 'git', ['worktree', 'add', '-b', 'card-r', wt]);
    writeFileSync(join(wt, 'r.txt'), 'r\n');
    sh(wt, 'git', ['add', '-A']);
    sh(wt, 'git', ['commit', '-m', 'Add r']);
    writeFileSync(join(repo.clone, 'base.txt'), 'b\n');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'Base moves']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    expect(await rebaseOntoBase(wt, 'main', PROJECT)).toBe('rebased');
    expect(sh(wt, 'git', ['log', '-1', '--format=%cn <%ce>'])).toBe('Pieter Jordaan <pieter@example.test>');
    expect(RebaseConflictError).toBeDefined();
  });

  it('saved work (stash commits) is made as the owner and refused when there is no identity', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo.clone, 'wip.txt'), 'unsaved\n');
    const ok = await saveUncommittedWork(repo.clone);
    expect(ok.saved?.stash).toBeDefined();
    expect(sh(repo.clone, 'git', ['stash', 'list', '--format=%an <%ae>|%cn <%ce>'])).toBe(
      `${OWNER.name} <${OWNER.email}>|${OWNER.name} <${OWNER.email}>`,
    );
    noGlobalIdentity();
    writeFileSync(join(repo.clone, 'wip2.txt'), 'more\n');
    const refused = await saveUncommittedWork(repo.clone);
    expect(refused.error).toBe(NO_COMMIT_IDENTITY_MESSAGE);
  });

  it('vault sync commits as the workstation identity with a plain message, not the DevOps agent', async () => {
    const root = tmp();
    const origin = join(root, 'vault.git');
    sh(root, 'git', ['init', '--bare', '-b', 'main', origin]);
    const dir = join(root, 'clone');
    sh(root, 'git', ['clone', origin, dir]);
    writeFileSync(join(dir, 'note.md'), 'hello\n');
    const r = await syncVault({
      dir,
      remoteUrl: origin,
      identity: { name: 'Atlas (aom)', email: 'atlas@agents.aom.invalid' },
      workstationName: 'Desk',
    });
    expect(r.status).toBe('ok');
    const line = sh(dir, 'git', ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%s']);
    expect(line).toMatch(
      /^Workstation Owner <owner@example\.test>\|Workstation Owner <owner@example\.test>\|Update notes /,
    );
    scanCommits(dir);
  });

  it('pull requests: title and body use the ticket key and the title, never a card ref, agent or product name', async () => {
    const repo = makeRepo();
    const calls: Array<{ title: string; body: string }> = [];
    for (const [ticket, ref, expected] of [
      ['DCPL-4276', 'P4-12', 'DCPL-4276: Add pr'],
      ['P4-12', 'P4-12', 'Add pr'],
    ] as const) {
      const wt = join(tmp(), 'wt');
      const branch = `card-${ref.toLowerCase()}-${calls.length}`;
      sh(repo.clone, 'git', ['worktree', 'add', '-b', branch, wt]);
      writeFileSync(join(wt, `${branch}.txt`), 'p\n');
      sh(wt, 'git', ['add', '-A']);
      sh(wt, 'git', ['commit', '-m', 'Add pr']);
      const res = await executeCompletion({
        payload: {
          cardId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
          ref,
          title: 'Add pr',
          projectKey: 'TOY',
          action: 'pr',
          repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2',
          remoteUrlNormalized: repo.remoteNormalized,
          baseBranch: 'main',
          branchName: branch,
          worktreePath: wt,
          ticket,
          prBranchPrefix: 'feature',
        } as never,
        repoPath: repo.clone,
        worktreePath: wt,
        worktreesDir: join(wt, '..'),
        integrationDir: tmp(),
        pr: {
          create: async (c: { title: string; body: string }) => {
            calls.push({ title: c.title, body: c.body });
            return { url: 'https://example.test/pull/1' };
          },
        } as never,
      });
      expect(res.ok).toBe(true);
      expect(calls[calls.length - 1]?.title).toBe(expected);
    }
    for (const c of calls) {
      expect(`${c.title}\n${c.body}`).not.toMatch(FORBIDDEN);
      expect(`${c.title}\n${c.body}`).not.toMatch(/\bP4-12\b(?!.*DCPL)/);
    }
  });
});
