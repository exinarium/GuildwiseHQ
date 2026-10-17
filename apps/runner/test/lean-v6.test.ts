import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIFF_MAX_BYTES,
  DIFF_TRUNCATED_NOTE,
  type FinalizeExecutePayload,
  type ShiftBrief,
} from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { computeCardDiff } from '../src/git/card-diff.ts';
import { executeCompletion } from '../src/git/completion.ts';
import type { PrCreator } from '../src/git/gh.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { e2eAreasSection, listSpecFiles } from '../src/testing/e2e-areas.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const BRANCH = 'aom/toy-1-lean';
const REPO_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';

async function cardWorktree(files: Record<string, string>) {
  const repo = makeRepo();
  const path = join(tmp(), 'wt');
  await ensureWorktree({
    repoPath: repo.clone,
    roots: ['/'],
    spec: {
      mode: 'create',
      repoId: REPO_ID,
      remoteUrlNormalized: repo.remoteNormalized,
      baseBranch: 'main',
      branchName: BRANCH,
    },
    defaultPath: path,
  });
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(path, f, '..'), { recursive: true });
    writeFileSync(join(path, f), text);
  }
  sh(path, 'git', ['add', '-A']);
  sh(path, 'git', ['commit', '-m', 'lean change']);
  return { repo, path };
}

describe('the card diff of a build handoff (code-v6)', () => {
  it('measures the commit, the changed paths and the unified diff', async () => {
    const { path } = await cardWorktree({
      'src/feature.ts': 'export const x = 1;\n',
      'migrations/1.sql': 'select 1;\n',
    });
    const head = sh(path, 'git', ['rev-parse', 'HEAD']).trim();
    const d = await computeCardDiff(path, 'main');
    expect(d.headSha).toBe(head);
    expect(d.changedPaths.sort()).toEqual(['migrations/1.sql', 'src/feature.ts']);
    expect(d.diff.truncated).toBe(false);
    expect(d.diff.text).toContain('diff --git a/src/feature.ts b/src/feature.ts');
    expect(d.diff.text).toContain('+export const x = 1;');
  });

  it('cuts a diff above 2 MB on a line and adds the note', async () => {
    const big = `${'const line = "x".repeat(10);\n'.repeat(90_000)}`; // about 2.6 MB
    const { path } = await cardWorktree({ 'src/big.ts': big });
    const d = await computeCardDiff(path, 'main');
    expect(d.diff.truncated).toBe(true);
    expect(d.diff.bytes).toBeGreaterThan(DIFF_MAX_BYTES);
    expect(d.diff.text.endsWith(DIFF_TRUNCATED_NOTE)).toBe(true);
    expect(Buffer.byteLength(d.diff.text)).toBeLessThanOrEqual(DIFF_MAX_BYTES + DIFF_TRUNCATED_NOTE.length);
    expect(d.changedPaths).toEqual(['src/big.ts']);
  });
});

describe('the runner lands only the reviewed commit', () => {
  const payload = (
    repo: { remoteNormalized: string },
    path: string,
    expectedSha?: string,
  ): FinalizeExecutePayload => ({
    cardId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
    ref: 'TOY-1',
    title: 'Lean',
    projectKey: 'TOY',
    action: 'merge',
    repoId: REPO_ID,
    remoteUrlNormalized: repo.remoteNormalized,
    baseBranch: 'main',
    branchName: BRANCH,
    worktreePath: path,
    ...(expectedSha ? { expectedSha } : {}),
  });
  const noPr: PrCreator = { create: async () => ({ unavailable: 'no gh' }) };
  const input = (repo: { clone: string }, p: FinalizeExecutePayload, path: string) => ({
    payload: p,
    repoPath: repo.clone,
    worktreePath: path,
    worktreesDir: '/',
    integrationDir: tmp(),
    pr: noPr,
  });

  it('refuses a branch that is at another commit than the reviewed one, before it rebases or merges anything', async () => {
    const { repo, path } = await cardWorktree({ 'a.txt': 'a\n' });
    const reviewed = sh(path, 'git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(path, 'b.txt'), 'late commit\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'a late commit']);
    const r = await executeCompletion(input(repo, payload(repo, path, reviewed), path));
    expect(r).toMatchObject({ ok: false, headMoved: true });
    expect(r.headSha).toBe(sh(path, 'git', ['rev-parse', 'HEAD']).trim());
  });

  it('merges the reviewed commit', async () => {
    const { repo, path } = await cardWorktree({ 'a.txt': 'a\n' });
    const reviewed = sh(path, 'git', ['rev-parse', 'HEAD']).trim();
    const r = await executeCompletion(input(repo, payload(repo, path, reviewed), path));
    expect(r.ok).toBe(true);
    expect(r.headMoved).toBeUndefined();
  });
});

describe('the aom CLI of the lean team', () => {
  async function cli() {
    const reports: unknown[] = [];
    const rpcs: Array<{ method: string; params: unknown }> = [];
    const { IpcServer } = await import('../src/ipc/server.ts');
    const ipc = new IpcServer();
    await ipc.start();
    const token = ipc.registerShift({
      report: async (r) => {
        reports.push(r.report);
        return { accepted: true, message: 'Recorded.' } as never;
      },
      rpc: async (r) => {
        rpcs.push({ method: r.method, params: r.params });
        return { ok: true, result: { message: 'ok' } };
      },
    });
    const out: string[] = [];
    const err: string[] = [];
    const ctx: AomContext = {
      env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      fetch,
      readFile: () => {
        throw new Error('no file');
      },
    };
    return { run: (...a: string[]) => runAom(a, ctx), reports, rpcs, out, err, stop: () => ipc.stop() };
  }

  it('hands off with build and unit test evidence, or a stated reason for none', async () => {
    const t = await cli();
    try {
      expect(
        await t.run(
          'handoff',
          '--note',
          'done',
          '--build-command',
          'pnpm build',
          '--build-result',
          'ok',
          '--test-command',
          'pnpm test',
          '--test-result',
          '3 passed',
        ),
      ).toBe(0);
      expect(t.reports[0]).toMatchObject({
        outcomeId: 'handoff',
        data: {
          buildEvidence: {
            commands: [
              { kind: 'build', command: 'pnpm build', status: 'passed', result: 'ok' },
              { kind: 'test', command: 'pnpm test', status: 'passed', result: '3 passed' },
            ],
          },
        },
      });
      expect(await t.run('handoff', '--note', 'docs', '--no-evidence', 'documentation only')).toBe(0);
      expect(t.reports[1]).toMatchObject({
        data: { buildEvidence: { commands: [], waived: 'documentation only' } },
      });
      // a result without its command, and both ways at once, are usage errors
      expect(await t.run('handoff', '--note', 'x', '--build-result', 'ok')).toBe(1);
      expect(await t.run('handoff', '--note', 'x', '--no-evidence', 'y', '--build-command', 'b')).toBe(1);
      // an older workflow's handoff has no evidence flags and sends none
      expect(await t.run('handoff', '--note', 'plain')).toBe(0);
      expect((t.reports[2] as { data: object }).data).toEqual({});
    } finally {
      await t.stop();
    }
  });

  it('plans, groups and writes the Card Brief', async () => {
    const t = await cli();
    try {
      expect(await t.run('plan', '--note', 'touches the desk page')).toBe(0);
      expect(t.reports[0]).toMatchObject({
        kind: 'outcome',
        outcomeId: 'planned',
        note: 'touches the desk page',
      });
      expect(await t.run('group', 'set', 'feature-x', '--card', 'TOY-2')).toBe(0);
      expect(await t.run('group', 'clear')).toBe(0);
      expect(await t.run('brief', '--text', 'Build X in module Y')).toBe(0);
      expect(t.rpcs).toEqual([
        { method: 'card.group', params: { id: 'feature-x', card: 'TOY-2' } },
        { method: 'card.group', params: { clear: true } },
        { method: 'card.brief', params: { text: 'Build X in module Y' } },
      ]);
      expect(await t.run('group', 'set')).toBe(1);
    } finally {
      await t.stop();
    }
  });
});

describe('the tester gets the E2E areas of the card', () => {
  const brief = (e2e: ShiftBrief['e2e'], extra: Partial<ShiftBrief['project']> = {}) =>
    ({
      e2e,
      project: { e2eGlobs: ['e2e/**'], ...extra },
    }) as unknown as ShiftBrief;

  it('lists the spec files of the worktree and maps the changed paths to them', async () => {
    const { path } = await cardWorktree({
      'e2e/tests/desk.spec.ts': '// desk\n',
      'e2e/tests/org-chart.spec.ts': '// chart\n',
      'e2e/tests/core-loop.spec.ts': '// core\n',
      'e2e/support/api.ts': '// helper\n',
      'apps/web/src/pages/Desk.tsx': '// page\n',
    });
    expect((await listSpecFiles(path, ['e2e/**'])).sort()).toEqual([
      'e2e/tests/core-loop.spec.ts',
      'e2e/tests/desk.spec.ts',
      'e2e/tests/org-chart.spec.ts',
    ]);
    const s = await e2eAreasSection(
      brief({ changedPaths: ['apps/web/src/pages/Desk.tsx'], mapping: null, hint: '' }),
      path,
    );
    expect(s?.selection).toMatchObject({ mode: 'areas', areas: ['desk'], specs: ['e2e/tests/desk.spec.ts'] });
    expect(s?.text).toContain('Run only these specs');
    expect(s?.text).toContain('e2e/tests/desk.spec.ts');
    expect(s?.text).toContain('Do not run the full suite');
  });

  it('the repository mapping file wins over the project setting; nothing matched runs the core specs', async () => {
    const { path } = await cardWorktree({
      'e2e/tests/desk.spec.ts': '// desk\n',
      'e2e/tests/core-loop.spec.ts': '// core\n',
      'e2e/areas.json': JSON.stringify({
        areas: [{ name: 'shared', paths: ['packages/shared/**'], specs: ['e2e/tests/desk.spec.ts'] }],
      }),
    });
    const mapped = await e2eAreasSection(
      brief({
        changedPaths: ['packages/shared/src/x.ts'],
        mapping: { areas: [], always: [], fallback: 'core' },
        hint: '',
      }),
      path,
    );
    expect(mapped?.selection).toMatchObject({ mode: 'areas', specs: ['e2e/tests/desk.spec.ts'] });
    const none = await e2eAreasSection(
      brief({ changedPaths: ['unrelated/x.ts'], mapping: null, hint: '' }),
      path,
    );
    expect(none?.selection).toMatchObject({ mode: 'core', specs: ['e2e/tests/core-loop.spec.ts'] });
  });

  it('a brief without changed paths (an older workflow) adds nothing', async () => {
    const { path } = await cardWorktree({ 'a.txt': 'a\n' });
    expect(
      await e2eAreasSection({ project: { e2eGlobs: [] } } as unknown as ShiftBrief, path),
    ).toBeUndefined();
  });
});
