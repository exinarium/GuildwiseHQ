import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ShiftBrief } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';
import { IDENTITY, makeVault, originFile } from './vault-fixtures.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const REPORT = 'docs/investigations/TOY-1-add-greeting.md';
const investigation = (over: Partial<NonNullable<ShiftBrief['investigation']>> = {}) => ({
  reportPath: REPORT,
  location: 'repo' as const,
  folder: 'docs/investigations',
  investigationOnly: false,
  mergeMainFirst: false,
  ...over,
});
const handoff = (data: Record<string, unknown>, id = 'handoff') => ({
  report: { kind: 'outcome', outcomeId: id, note: 'done', data },
});
const data = (over: Record<string, unknown> = {}) => ({
  reportPath: REPORT,
  summary: 'Build it in the greeting module.',
  location: 'repo',
  ...over,
});
const write = (wt: string, rel: string, text: string) => {
  mkdirSync(dirname(join(wt, rel)), { recursive: true });
  writeFileSync(join(wt, rel), text);
};
const commit = (wt: string) => {
  sh(wt, 'git', ['add', '-A']);
  sh(wt, 'git', ['commit', '-m', 'agent work']);
};

async function start(script: ConstructorParameters<typeof ScriptedAdapter>[0], runnerOpts = {}) {
  const adapter = new ScriptedAdapter(script);
  h = await startHarness({}, { adapters: new Map([['mock', adapter]]), ...runnerOpts });
  return adapter;
}

describe('architect shift: the investigation outcome', () => {
  it('a committed report is accepted and carries the commit', async () => {
    let head = '';
    await start(async (i, ctl) => {
      write(i.cwd, REPORT, '# TOY-1\n\nFindings and design.\n');
      commit(i.cwd);
      head = sh(i.cwd, 'git', ['rev-parse', 'HEAD']);
      const r = await ctl.post('/v1/report', handoff(data()));
      expect(r.status).toBe(200);
    });
    const { shiftId, ended } = await h!.runShift({
      stage: 'investigate',
      briefExtra: { investigation: investigation() },
    });
    expect(ended.outcome).toBe('reported');
    const rep = h!.server.of('shift.report').find((r) => r.shiftId === shiftId);
    expect(rep?.report).toMatchObject({
      kind: 'outcome',
      outcomeId: 'handoff',
      data: { reportPath: REPORT, location: 'repo', commit: head },
    });
  });

  it('an uncommitted report is committed for the architect before it is checked', async () => {
    let wt = '';
    await start(async (i, ctl) => {
      wt = i.cwd;
      write(i.cwd, REPORT, '# TOY-1\n');
      expect((await ctl.post('/v1/report', handoff(data()))).status).toBe(200);
    });
    await h!.runShift({ stage: 'investigate', briefExtra: { investigation: investigation() } });
    expect(sh(wt, 'git', ['status', '--porcelain'])).toBe('');
    expect(sh(wt, 'git', ['show', '--stat', '--format=%s', 'HEAD'])).toContain(REPORT);
  });

  it('product code is refused by the guard; the report is not accepted until it is removed', async () => {
    const seen: any = {};
    await start(async (i, ctl) => {
      write(i.cwd, REPORT, '# TOY-1\n');
      write(i.cwd, 'src/greeting.ts', 'export const hi = 1;\n');
      seen.first = await ctl.post('/v1/report', handoff(data()));
      sh(i.cwd, 'git', ['rm', '-f', '--cached', '--ignore-unmatch', 'src/greeting.ts']);
      sh(i.cwd, 'rm', ['-f', 'src/greeting.ts']);
      seen.second = await ctl.post('/v1/report', handoff(data()));
    });
    const { ended } = await h!.runShift({
      stage: 'investigate',
      briefExtra: { investigation: investigation() },
    });
    expect(seen.first.status).toBe(422);
    expect(seen.first.json.guardViolations[0].rule).toBe('architect_edited_non_docs');
    expect(seen.second.status).toBe(200);
    expect(ended.guardViolations.map((v) => v.rule)).toContain('architect_edited_non_docs');
  });

  it('a report with a secret in it is refused, then accepted without it', async () => {
    const seen: any = {};
    await start(async (i, ctl) => {
      write(i.cwd, REPORT, `# TOY-1\n\ntoken = ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}\n`);
      commit(i.cwd);
      seen.first = await ctl.post('/v1/report', handoff(data()));
      write(i.cwd, REPORT, '# TOY-1\n\nNo secrets here.\n');
      commit(i.cwd);
      seen.second = await ctl.post('/v1/report', handoff(data()));
    });
    await h!.runShift({ stage: 'investigate', briefExtra: { investigation: investigation() } });
    expect(seen.first.status).toBe(422);
    expect(seen.first.json.error).toContain('GitHub token');
    expect(seen.first.json.error).not.toContain('ghp_');
    expect(seen.second.status).toBe(200);
  });

  it('a missing report, a path outside the worktree and a symlink out are refused', async () => {
    const seen: Record<string, any> = {};
    await start(async (i, ctl) => {
      seen.missing = await ctl.post('/v1/report', handoff(data()));
      seen.up = await ctl.post('/v1/report', handoff(data({ reportPath: '../outside.md' })));
      seen.abs = await ctl.post('/v1/report', handoff(data({ reportPath: '/etc/hostname' })));
      mkdirSync(join(i.cwd, 'docs', 'investigations'), { recursive: true });
      symlinkSync('/etc/hostname', join(i.cwd, REPORT));
      commit(i.cwd);
      seen.link = await ctl.post('/v1/report', handoff(data()));
    });
    await h!.runShift({ stage: 'investigate', briefExtra: { investigation: investigation() } });
    expect(seen.missing.status).toBe(422);
    expect(seen.missing.json.error).toContain('does not exist');
    expect(seen.up.status).toBe(422);
    expect(seen.abs.status).toBe(422);
    expect(seen.link.status).toBe(422);
  });

  it('a report in the vault is copied into the project vault by the runner and nothing is committed', async () => {
    const seen: any = {};
    await start(async (i, ctl) => {
      writeFileSync(join(i.sandbox.tmp, 'TOY-1-add-greeting.md'), '# vault report\n');
      seen.r = await ctl.post(
        '/v1/report',
        handoff(data({ reportPath: join(i.sandbox.tmp, 'TOY-1-add-greeting.md') })),
      );
    });
    const vault = makeVault({ 'projects/toy/PROJECT.md': '# Toy\n' });
    h!.server.send('command', {
      commandId: 'cfg',
      command: 'vault.configure',
      payload: {
        vaults: [
          { vaultId: 'vault-1', kind: 'org', name: 'Org', remoteUrl: vault.origin, syncIntervalSec: 3600 },
        ],
        identity: IDENTITY,
        workstationName: 'Desk',
      },
    });
    expect((await h!.server.waitFor('command.result', (m) => m.commandId === 'cfg')).ok).toBe(true);
    const { shiftId, ended } = await h!.runShift({
      stage: 'investigate',
      briefExtra: {
        investigation: investigation({
          location: 'vault',
          reportPath: 'docs/investigations/TOY-1-add-greeting.md',
          folder: undefined,
        }),
      },
      startExtra: { vault: { vaultId: 'vault-1', kind: 'org', folder: 'projects/toy' } },
    });
    expect(seen.r.status).toBe(200);
    expect(ended.outcome).toBe('reported');
    const vaultPath = 'projects/toy/docs/investigations/TOY-1-add-greeting.md';
    const rep = h!.server.of('shift.report').find((r) => r.shiftId === shiftId);
    expect(rep?.report).toMatchObject({ data: { reportPath: vaultPath, location: 'vault' } });
    expect((rep?.report as { data?: { commit?: string } } | undefined)?.data?.commit).toBeUndefined();
    // the report is in the vault's origin, committed and pushed by the runner
    expect(originFile(vault, vaultPath).trim()).toBe('# vault report');
    // and nothing was committed to the repository
    expect(sh(h!.repo.clone, 'git', ['log', '--all', '--format=%s', '--', 'docs'])).toBe('');
  });

  it('a vault report with no vault configured is refused with a clear reason', async () => {
    const seen: any = {};
    await start(async (i, ctl) => {
      writeFileSync(join(i.sandbox.tmp, 'r.md'), '# r\n');
      seen.r = await ctl.post('/v1/report', handoff(data({ reportPath: join(i.sandbox.tmp, 'r.md') })));
    });
    await h!.runShift({
      stage: 'investigate',
      briefExtra: { investigation: investigation({ location: 'vault', folder: undefined }) },
    });
    expect(seen.r.status).toBe(422);
    expect(seen.r.json.error).toContain('no knowledge vault');
  });
});

describe('architect shift: git run by the runner', () => {
  it('git.push publishes the card branch only; other refs and other stages are refused', async () => {
    const seen: Record<string, any> = {};
    let branch = '';
    await start(async (i, ctl) => {
      branch = sh(i.cwd, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
      write(i.cwd, REPORT, '# r\n');
      commit(i.cwd);
      seen.main = await ctl.post('/v1/rpc', { method: 'git.push', params: { branch: 'main' } });
      seen.ok = await ctl.post('/v1/rpc', { method: 'git.push', params: {} });
      seen.fetch = await ctl.post('/v1/rpc', { method: 'git.fetch', params: {} });
    });
    await h!.runShift({ stage: 'investigate', briefExtra: { investigation: investigation() } });
    expect(seen.main.json.ok).toBe(false);
    expect(seen.main.json.error).toContain('only the card branch');
    expect(seen.ok.json.ok).toBe(true);
    expect(seen.fetch.json.ok).toBe(true);
    expect(sh(h!.repo.origin, 'git', ['branch', '--list', branch]).trim()).toContain(branch);
    expect(sh(h!.repo.origin, 'git', ['log', '--format=%s', 'main'])).toBe('initial');
  });

  it('a builder cannot use the architect git verbs', async () => {
    const seen: Record<string, any> = {};
    await start(async (_i, ctl) => {
      for (const m of ['git.push', 'git.fetch', 'git.merge_main', 'git.verify_merge'])
        seen[m] = await ctl.post('/v1/rpc', { method: m, params: {} });
    });
    await h!.runShift({ stage: 'build' });
    for (const m of ['git.push', 'git.fetch', 'git.merge_main', 'git.verify_merge']) {
      expect(seen[m].json.ok, m).toBe(false);
      expect(seen[m].json.error, m).toContain('architect');
    }
  });
});

describe('architect shift: merge latest main first', () => {
  /** origin gets a `work` branch, then main moves; `edit` lets a test make main conflict with work. */
  function workAndMain(opts: { conflict?: boolean } = {}) {
    const repo = h!.repo;
    sh(repo.clone, 'git', ['checkout', '-b', 'work']);
    if (opts.conflict) {
      writeFileSync(join(repo.clone, 'README.md'), 'work side\n');
      sh(repo.clone, 'git', ['commit', '-am', 'work edits readme']);
    }
    sh(repo.clone, 'git', ['push', '-u', 'origin', 'work']);
    sh(repo.clone, 'git', ['checkout', 'main']);
    const other = join(tmp(), 'other');
    sh(repo.root, 'git', ['clone', repo.origin, other]);
    sh(other, 'git', ['checkout', 'main']);
    writeFileSync(join(other, opts.conflict ? 'README.md' : 'main-only.txt'), 'main side\n');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', 'main moves']);
    sh(other, 'git', ['push', 'origin', 'main']);
  }
  const prepare = { syncMain: { mainBranch: 'main', workingBranch: 'work' } };
  const worktreeExtra = { baseBranch: 'work', mainBranch: 'main' };

  it('merges main into the working branch before the card branch is cut and reports it', async () => {
    let seenFile = '';
    await start(async (i) => {
      seenFile = existsSync(join(i.cwd, 'main-only.txt'))
        ? readFileSync(join(i.cwd, 'main-only.txt'), 'utf8')
        : '';
    });
    workAndMain();
    await h!.runShift({
      stage: 'investigate',
      briefExtra: { investigation: investigation({ mergeMainFirst: true }) },
      prepare,
      worktreeExtra,
    });
    expect(seenFile).toBe('main side\n');
    const started = h!.server.of('shift.started').at(-1);
    expect(started?.syncMain).toMatchObject({ result: 'merged_into_working' });
    expect(sh(h!.repo.origin, 'git', ['show', 'work:main-only.txt'])).toBe('main side');
  });

  const mergeHead = (wt: string): boolean =>
    spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wt }).status === 0;

  it('a conflict is left in the architect worktree; the report waits until it is resolved and verified', async () => {
    const seen: Record<string, any> = {};
    await start(async (i, ctl) => {
      seen.prompt = i.prompt;
      seen.inProgress = mergeHead(i.cwd);
      write(i.cwd, REPORT, '# r\n');
      seen.early = await ctl.post('/v1/report', handoff(data()));
      seen.verifyEarly = await ctl.post('/v1/rpc', { method: 'git.verify_merge', params: {} });
      // resolve it the way the architect would: both sides kept, no behaviour change
      writeFileSync(join(i.cwd, 'README.md'), 'work side\nmain side\n');
      sh(i.cwd, 'git', ['add', 'README.md']);
      sh(i.cwd, 'git', ['commit', '--no-edit']);
      seen.verify = await ctl.post('/v1/rpc', { method: 'git.verify_merge', params: {} });
      commit(i.cwd);
      seen.report = await ctl.post('/v1/report', handoff(data()));
    });
    workAndMain({ conflict: true });
    const { ended } = await h!.runShift({
      stage: 'investigate',
      briefExtra: { investigation: investigation({ mergeMainFirst: true }) },
      prepare,
      worktreeExtra,
    });
    expect(h!.server.of('shift.started').at(-1)?.syncMain).toMatchObject({
      result: 'conflict_in_card',
      files: ['README.md'],
    });
    expect(seen.prompt).toContain('A merge of the main branch is waiting in your worktree');
    expect(seen.prompt).toContain('README.md');
    expect(seen.inProgress).toBe(true);
    // refused while the merge is unfinished (and nothing is committed on the agent's behalf)
    expect(seen.early.status).toBe(422);
    expect(seen.early.json.guardViolations.map((v: any) => v.rule)).toEqual(['merge_unresolved']);
    expect(seen.verifyEarly.json.ok).toBe(false);
    // resolved: verified, and the report is accepted although the merge brought README.md in
    expect(seen.verify.json.ok).toBe(true);
    expect(seen.report.status).toBe(200);
    expect(ended.outcome).toBe('reported');
    expect(ended.guardViolations.map((v) => v.rule)).toEqual(['merge_unresolved']);
  });

  it('an unfinished merge is not committed at shift end; the next architect shift inherits it', async () => {
    const seen: Record<string, any> = {};
    let n = 0;
    await start(async (i, ctl) => {
      n++;
      if (n === 1) return; // the first architect gives up without touching anything
      seen.prompt = i.prompt;
      seen.inProgress = mergeHead(i.cwd);
      writeFileSync(join(i.cwd, 'README.md'), 'work side\nmain side\n');
      sh(i.cwd, 'git', ['add', 'README.md']);
      sh(i.cwd, 'git', ['commit', '--no-edit']);
      write(i.cwd, REPORT, '# r\n');
      commit(i.cwd);
      seen.report = await ctl.post('/v1/report', handoff(data()));
    });
    workAndMain({ conflict: true });
    const opts = {
      stage: 'investigate' as const,
      briefExtra: { investigation: investigation({ mergeMainFirst: true }) },
      worktreeExtra,
    };
    await h!.runShift({ ...opts, prepare });
    const wt = join(h!.dataDir, 'worktrees');
    const dir = sh(wt, 'ls', []).split('\n')[0] as string;
    const path = join(wt, dir, 'TOY-1');
    expect(mergeHead(path)).toBe(true);
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toContain('<<<<<<<'); // markers were not committed
    await h!.runShift({ ...opts, mode: 'reuse', worktreePath: path });
    expect(seen.inProgress).toBe(true);
    expect(seen.prompt).toContain('A merge of the main branch is waiting in your worktree');
    expect(seen.report.status).toBe(200);
  });

  it('a conflict with nobody to resolve it (a builder) is aborted and the work goes ahead', async () => {
    let clean = '';
    let inProgress = true;
    await start(async (i) => {
      clean = sh(i.cwd, 'git', ['status', '--porcelain']);
      inProgress = mergeHead(i.cwd);
    });
    workAndMain({ conflict: true });
    await h!.runShift({ stage: 'build', prepare, worktreeExtra });
    expect(h!.server.of('shift.started').at(-1)?.syncMain).toMatchObject({
      result: 'skipped_conflict',
      files: ['README.md'],
    });
    expect(clean).toBe('');
    expect(inProgress).toBe(false);
  });

  it('a protected working branch makes the card branch take the merge', async () => {
    let merged = '';
    await start(async (i) => {
      merged = existsSync(join(i.cwd, 'main-only.txt')) ? 'yes' : 'no';
    });
    workAndMain();
    const hook = join(h!.repo.origin, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = "refs/heads/work" ]; then echo "protected branch: GH006" >&2; exit 1; fi; done\n',
    );
    chmodSync(hook, 0o755);
    const before = sh(h!.repo.origin, 'git', ['rev-parse', 'work']);
    await h!.runShift({
      stage: 'investigate',
      briefExtra: { investigation: investigation({ mergeMainFirst: true }) },
      prepare,
      worktreeExtra,
    });
    expect(merged).toBe('yes');
    expect(h!.server.of('shift.started').at(-1)?.syncMain).toMatchObject({ result: 'merged_into_card' });
    expect(sh(h!.repo.origin, 'git', ['rev-parse', 'work'])).toBe(before);
  });

  it('is skipped for a shift without the setting, and never on reuse', async () => {
    await start(async () => {});
    workAndMain();
    await h!.runShift({
      stage: 'investigate',
      briefExtra: { investigation: investigation() },
      worktreeExtra,
    });
    expect(h!.server.of('shift.started').at(-1)?.syncMain).toBeUndefined();
    // a later stage reuses the worktree: no sync even when the server asks
    await h!.runShift({ stage: 'review', prepare, worktreeExtra: { ...worktreeExtra, mode: 'reuse' } });
    expect(h!.server.of('shift.started').at(-1)?.syncMain).toBeUndefined();
  });
});
