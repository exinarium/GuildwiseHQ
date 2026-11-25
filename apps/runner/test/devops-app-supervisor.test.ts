import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRemoteUrl, type PostAsPlan, postAsFor } from '@aom/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppIdentityError } from '../src/git/identity.ts';
import type { SupervisorDeps } from '../src/shifts/supervisor.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';
import { makeDevopsStart } from './vault-fixtures.ts';

/**
 * The DevOps engineer's runner-run git (`aom git push|fetch --repo`, rpc git.push/git.fetch) and repository hygiene
 * (`aom hygiene run`, rpc hygiene.run) through the real supervisor and IPC: the app token is used by the runner, never
 * handed to the agent; a mint failure names project, app and operation; nothing reaches origin and the owner's git
 * credentials are never asked for.
 */

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const INTEGRATION = '0b9f3c0e-1d2a-4c1b-9a51-6f0e2a7d8c11';
const APP = {
  integrationId: INTEGRATION,
  provider: 'github-app' as const,
  label: 'Guild Bot',
  botName: 'guild-bot[bot]',
  botEmail: '99+guild-bot[bot]@users.noreply.github.com',
  instance: '4242:777',
  host: 'github.com',
};
const APP_TOKEN_MARK = 'app-token-used';
const U = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';

const planFor = (remote: string, source: 'app' | 'project' = 'app'): PostAsPlan => ({
  repos: [
    {
      repoId: '0b9f3c0e-1d2a-4c1b-9a51-6f0e2a7d8c12',
      remoteUrlNormalized: remote,
      source,
      projectKey: 'GWP',
      ...(source === 'app' ? { app: APP } : {}),
    },
  ],
});

/** origin logs the token marker of each pushing process (a local push runs receive-pack with the pusher's env). */
function recordPushes(repo: TestRepo): () => string[] {
  const log = join(repo.root, 'pushes.log');
  const hook = join(repo.origin, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh\necho "\${APP_TOKEN_MARK:-owner}" >> '${log}'\ncat >/dev/null\n`);
  chmodSync(hook, 0o755);
  return () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
}

/** Fake post-as credentials: the app auth carries the token marker; `fail` makes the mint fail. */
function fakeCredentials(fail: boolean) {
  const auth = vi.fn(async (_url: string) => {
    if (fail) throw new AppIdentityError(APP, 'the installation was revoked');
    return { args: [] as string[], env: { APP_TOKEN_MARK } };
  });
  const ownerAuth = vi.fn(async () => ({ args: [] as string[], env: { APP_TOKEN_MARK: 'owner-helper' } }));
  const overrides: Partial<SupervisorDeps> = {
    gitAuth: ownerAuth,
    shiftCredentials: (plan) => ({
      auth,
      originRefusal: () => null,
      appFor: (url) => {
        const e = postAsFor(plan, normalizeRemoteUrl(url));
        return e?.source === 'app' && e.app
          ? { label: e.app.label, botName: e.app.botName, botEmail: e.app.botEmail }
          : null;
      },
    }),
  };
  return { auth, ownerAuth, overrides };
}

async function runDevops(
  repo: TestRepo,
  over: Partial<SupervisorDeps>,
  extra: Record<string, unknown>,
  script: ConstructorParameters<typeof ScriptedAdapter>[0],
) {
  const adapter = new ScriptedAdapter(script);
  h = await startHarness({}, { adapters: new Map([['mock', adapter]]), supervisorOverrides: over }, repo);
  const base = makeDevopsStart({ summary: 'tidy the repositories' }) as Record<string, any>;
  const msg: Record<string, any> = {
    ...base,
    ...extra,
    devops: { ...base.devops, ...((extra.devops as object | undefined) ?? {}) },
  };
  h.server.send('shift.start', msg);
  await h.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
  await h.runner.supervisor.whenSettled(msg.shiftId);
  return adapter;
}

/** A local branch with one commit, ready to push. */
function localBranch(repo: TestRepo, branch: string) {
  sh(repo.clone, 'git', ['checkout', '-q', '-b', branch]);
  writeFileSync(join(repo.clone, `${branch.replace(/\//g, '-')}.txt`), 'x');
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-q', '-m', branch]);
  sh(repo.clone, 'git', ['checkout', '-q', 'main']);
}

const originBranches = (repo: TestRepo) =>
  sh(repo.origin, 'git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/tags'])
    .split('\n')
    .filter(Boolean)
    .sort();

describe('aom git push|fetch --repo on an app repository (supervisor rpc)', () => {
  it('push, tag push and branch delete go out with the app token; the agent env never holds it', async () => {
    const repo = makeRepo();
    localBranch(repo, 'aom/gwp-1-fix');
    sh(repo.clone, 'git', ['tag', 'v1.0.0']);
    const pushes = recordPushes(repo);
    const c = fakeCredentials(false);
    const seen: Record<string, any> = {};
    const adapter = await runDevops(
      repo,
      c.overrides,
      { postAs: planFor(repo.remoteNormalized) },
      async (_i, ctl) => {
        seen.push = await ctl.post('/v1/rpc', {
          method: 'git.push',
          params: { repo: repo.clone, refspecs: ['aom/gwp-1-fix'] },
        });
        seen.tag = await ctl.post('/v1/rpc', {
          method: 'git.push',
          params: { repo: repo.clone, refspecs: ['refs/tags/v1.0.0'] },
        });
        seen.del = await ctl.post('/v1/rpc', {
          method: 'git.push',
          params: { repo: repo.clone, refspecs: ['aom/gwp-1-fix'], delete: true },
        });
        seen.fetch = await ctl.post('/v1/rpc', { method: 'git.fetch', params: { repo: repo.clone } });
      },
    );
    for (const k of ['push', 'tag', 'del', 'fetch'])
      expect(seen[k].json.ok, `${k}: ${seen[k].json.error}`).toBe(true);
    expect(seen.push.json.result.message).toBeTruthy();
    expect(pushes()).toEqual([APP_TOKEN_MARK, APP_TOKEN_MARK, APP_TOKEN_MARK]);
    expect(originBranches(repo)).toEqual(['main', 'v1.0.0']);
    expect(c.auth).toHaveBeenCalledWith(repo.origin);
    expect(c.ownerAuth).not.toHaveBeenCalled();
    // The agent process never sees the token environment.
    const env = adapter.inputs[0]?.env ?? {};
    expect(Object.values(env).join('\n')).not.toContain(APP_TOKEN_MARK);
    expect(env.APP_TOKEN_MARK).toBeUndefined();
  });

  it('the app cannot mint: every operation fails naming project, app and operation; nothing reaches origin', async () => {
    const repo = makeRepo();
    localBranch(repo, 'aom/gwp-2-fix');
    sh(repo.clone, 'git', ['push', '-q', 'origin', 'aom/gwp-2-fix']);
    localBranch(repo, 'aom/gwp-3-fix');
    sh(repo.clone, 'git', ['tag', 'v2.0.0']);
    const pushes = recordPushes(repo);
    const before = originBranches(repo);
    const c = fakeCredentials(true);
    const seen: Record<string, any> = {};
    await runDevops(repo, c.overrides, { postAs: planFor(repo.remoteNormalized) }, async (_i, ctl) => {
      seen.push = await ctl.post('/v1/rpc', {
        method: 'git.push',
        params: { repo: repo.clone, refspecs: ['aom/gwp-3-fix'] },
      });
      seen['push tag'] = await ctl.post('/v1/rpc', {
        method: 'git.push',
        params: { repo: repo.clone, refspecs: [], tags: true },
      });
      seen['delete branch'] = await ctl.post('/v1/rpc', {
        method: 'git.push',
        params: { repo: repo.clone, refspecs: ['aom/gwp-2-fix'], delete: true },
      });
      seen.fetch = await ctl.post('/v1/rpc', { method: 'git.fetch', params: { repo: repo.clone } });
    });
    for (const op of ['push', 'push tag', 'delete branch', 'fetch']) {
      const r = seen[op].json;
      expect(r.ok, op).toBe(false);
      expect(r.error, op).toMatch(/^app_identity_failed: The app Guild Bot could not be used/);
      expect(r.error, op).toContain('GWP');
      expect(r.error, op).toContain(op);
    }
    expect(pushes()).toEqual([]);
    expect(originBranches(repo)).toEqual(before);
    expect(c.ownerAuth).not.toHaveBeenCalled();
  });

  it('a protected branch is never deleted, also as a src:dst refspec; nothing is asked of the credentials', async () => {
    const repo = makeRepo();
    const c = fakeCredentials(false);
    const seen: Record<string, any> = {};
    await runDevops(repo, c.overrides, { postAs: planFor(repo.remoteNormalized) }, async (_i, ctl) => {
      for (const spec of ['main', 'refs/heads/main', 'main:refs/heads/main', ':main', 'HEAD'])
        seen[spec] = await ctl.post('/v1/rpc', {
          method: 'git.push',
          params: { repo: repo.clone, refspecs: [spec], delete: true },
        });
    });
    for (const spec of ['main', 'refs/heads/main', 'main:refs/heads/main', ':main', 'HEAD'])
      expect(seen[spec].json.ok, spec).toBe(false);
    expect(originBranches(repo)).toEqual(['main']);
    expect(c.auth).not.toHaveBeenCalled();
  });

  it('a repository not on an app pushes with plain git, exactly as before (no app auth, no owner helper)', async () => {
    const repo = makeRepo();
    localBranch(repo, 'aom/gwp-4-fix');
    const pushes = recordPushes(repo);
    const c = fakeCredentials(true);
    const seen: Record<string, any> = {};
    await runDevops(
      repo,
      c.overrides,
      { postAs: planFor(repo.remoteNormalized, 'project') },
      async (_i, ctl) => {
        seen.push = await ctl.post('/v1/rpc', {
          method: 'git.push',
          params: { repo: repo.clone, refspecs: ['aom/gwp-4-fix'] },
        });
      },
    );
    expect(seen.push.json.ok, seen.push.json.error).toBe(true);
    expect(pushes()).toEqual(['owner']);
    expect(c.auth).not.toHaveBeenCalled();
    expect(c.ownerAuth).not.toHaveBeenCalled();
  });
});

/**
 * quiet-approvals [B4]: a hygiene request is the fixed routine (no AI session): the runner runs it and reports
 * `devops_done` with the report, as `aom hygiene run` did. The result is read from that report.
 */
async function hygieneReport(
  repo: TestRepo,
  over: Partial<SupervisorDeps>,
  extra: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; adapter: ScriptedAdapter }> {
  const adapter = await runDevops(repo, over, extra, async () => {
    throw new Error('a hygiene request never starts an AI session');
  });
  const rep = h?.server.of('shift.report').at(-1) as unknown as {
    report: { outcomeId: string; data: { hygiene: unknown; summary: string; commands: string[] } };
  };
  expect(rep.report.outcomeId).toBe('devops_done');
  expect(adapter.inputs).toHaveLength(0);
  return { result: { report: rep.report.data.hygiene, ...rep.report.data }, adapter };
}

describe('repository hygiene in the runner: the fixed routine (quiet-approvals [B4])', () => {
  const hygiene = (repo: TestRepo) => ({
    trigger: 'manual',
    repos: [
      {
        repoId: U,
        projectId: U,
        projectKey: 'GWP',
        projectName: 'Guild',
        name: 'toy',
        localPath: repo.clone,
        remoteUrl: repo.origin,
        workingBranch: 'main',
        branchSource: 'repo',
        branchPrefix: 'aom/',
        finishedBranches: [],
        mainBranch: null,
        finishedCards: [],
      },
    ],
  });

  /** Somebody else moves main on origin, so hygiene has to pull --rebase before it pushes. */
  function remoteCommit(repo: TestRepo) {
    const other = join(tmp(), 'other');
    sh(repo.root, 'git', ['clone', '-q', repo.origin, other]);
    writeFileSync(join(other, 'theirs.txt'), 'theirs');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', [
      '-c',
      'user.name=Other',
      '-c',
      'user.email=other@example.test',
      'commit',
      '-q',
      '-m',
      'theirs',
    ]);
    sh(other, 'git', ['push', '-q', 'origin', 'main']);
  }

  function ownerCommit(repo: TestRepo) {
    writeFileSync(join(repo.clone, 'mine.txt'), 'mine');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-q', '--author', 'Owner <owner@example.test>', '-m', 'mine']);
    return sh(repo.clone, 'git', ['rev-parse', 'HEAD']).trim();
  }

  it('pulls and pushes with the app token; the rebased commit keeps its author and gets the app as committer', async () => {
    const repo = makeRepo();
    remoteCommit(repo);
    ownerCommit(repo);
    const pushes = recordPushes(repo);
    const c = fakeCredentials(false);
    const { result, adapter } = await hygieneReport(repo, c.overrides, {
      postAs: planFor(repo.remoteNormalized),
      devops: { hygiene: hygiene(repo) },
    });
    const res: any = { json: { ok: true, result } };
    const r = res.json.result.report.repos[0];
    expect(r.problem).toBeNull();
    expect(r.pushed).toBe(true);
    expect(pushes()).toEqual([APP_TOKEN_MARK]);
    // Hygiene never rewrites authorship: the person who wrote the commit stays its author; the app is the committer.
    expect(sh(repo.origin, 'git', ['log', '-1', '--format=%an|%cn|%ce', 'main']).trim()).toBe(
      `Owner|${APP.botName}|${APP.botEmail}`,
    );
    expect(c.ownerAuth).not.toHaveBeenCalled();
    expect(JSON.stringify(res.json.result)).not.toContain(APP_TOKEN_MARK);
    // no AI session at all, so no agent environment that could hold the token
    expect(adapter.inputs).toHaveLength(0);
  });

  it('the app cannot mint: app_identity_failed naming project, hygiene and the app; nothing pushed', async () => {
    const repo = makeRepo();
    ownerCommit(repo);
    const pushes = recordPushes(repo);
    const before = sh(repo.origin, 'git', ['rev-parse', 'main']);
    const c = fakeCredentials(true);
    const res: any = {
      json: {
        result: (
          await hygieneReport(repo, c.overrides, {
            postAs: planFor(repo.remoteNormalized),
            devops: { hygiene: hygiene(repo) },
          })
        ).result,
      },
    };
    const r = res.json.result.report.repos[0];
    expect(r.problem.kind).toBe('app_identity_failed');
    expect(r.problem.detail).toContain('Guild Bot');
    expect(r.problem.detail).toContain('GWP');
    expect(r.problem.detail).toContain('hygiene');
    expect(r.pushed).toBe(false);
    expect(pushes()).toEqual([]);
    expect(sh(repo.origin, 'git', ['rev-parse', 'main'])).toBe(before);
    expect(c.ownerAuth).not.toHaveBeenCalled();
  });

  it('no app selected: plain git and the owner as author and committer, as before', async () => {
    const repo = makeRepo();
    const local = ownerCommit(repo);
    const pushes = recordPushes(repo);
    const c = fakeCredentials(true);
    const res: any = {
      json: {
        result: (await hygieneReport(repo, c.overrides, { devops: { hygiene: hygiene(repo) } })).result,
      },
    };
    expect(res.json.result.report.repos[0].pushed).toBe(true);
    expect(pushes()).toEqual(['owner']);
    // the very commit made locally, unchanged
    expect(sh(repo.origin, 'git', ['rev-parse', 'main']).trim()).toBe(local);
    expect(sh(repo.origin, 'git', ['log', '-1', '--format=%an', 'main']).trim()).toBe('Owner');
    expect(c.auth).not.toHaveBeenCalled();
    expect(c.ownerAuth).not.toHaveBeenCalled();
  });
});
