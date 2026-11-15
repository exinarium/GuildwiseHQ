import { APP_ERROR_TEXT, type PostAsRepo } from '@aom/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appTokenProbe, checkAppAccess, splitRemote } from '../src/apps/access-check.ts';
import { AppTokenError } from '../src/apps/types.ts';
import {
  AppIdentityError,
  appIdentityWire,
  appReason,
  identityErrorWire,
  repoNameOf,
  requireCommitIdentity,
  resolveCommitIdentity,
  setAppTokenProbe,
} from '../src/git/identity.ts';
import { rebaseEnv } from '../src/git/rebase.ts';
import { cleanupTmp, makeRepo, sh } from './helpers.ts';

cleanupTmp();

const APP_ID = '0190f1a0-0000-7000-8000-000000000001';
const REPO_A = '0190f1a0-0000-7000-8000-00000000000a';
const REPO_B = '0190f1a0-0000-7000-8000-00000000000b';
const PROJECT = { name: 'Pieter Jordaan', email: 'pieter@example.test' };
const app = {
  integrationId: APP_ID,
  provider: 'github-app' as const,
  label: 'Acme bot',
  botName: 'acme-bot[bot]',
  botEmail: '123+acme-bot[bot]@users.noreply.github.com',
  instance: '42:777',
  host: 'github.com',
};
const appEntry: PostAsRepo = { repoId: REPO_A, remoteUrlNormalized: 'github.com/acme/a', source: 'app', app };

afterEach(() => setAppTokenProbe(null));

function repoWithConfig() {
  const repo = makeRepo();
  sh(repo.clone, 'git', ['config', 'user.name', 'Repo Person']);
  sh(repo.clone, 'git', ['config', 'user.email', 'repo@example.test']);
  return repo;
}

describe('resolution order with a post-as plan', () => {
  it('app covering the repository: the bot identity, after a scoped mint for that repository', async () => {
    const ensure = vi.fn(async () => {});
    setAppTokenProbe({ ensure });
    const repo = repoWithConfig();
    const id = await resolveCommitIdentity(repo.clone, PROJECT, appEntry);
    expect(id).toEqual({
      name: 'acme-bot[bot]',
      email: '123+acme-bot[bot]@users.noreply.github.com',
      source: 'app',
      app: { integrationId: APP_ID, provider: 'github-app' },
    });
    expect(ensure).toHaveBeenCalledWith({ instance: '42:777', integrationId: APP_ID }, 'acme/a');
  });

  it('app not covering the repository (server resolved to the fallback): Commit as, the probe is never asked', async () => {
    const ensure = vi.fn(async () => {});
    setAppTokenProbe({ ensure });
    const repo = repoWithConfig();
    const entry: PostAsRepo = {
      ...appEntry,
      source: 'project',
      app: undefined,
      fallbackReason: 'not_covered',
    };
    expect(await resolveCommitIdentity(repo.clone, PROJECT, entry)).toEqual({
      ...PROJECT,
      source: 'project',
    });
    const repoEntry: PostAsRepo = {
      ...appEntry,
      source: 'repo',
      app: undefined,
      fallbackReason: 'not_covered',
    };
    expect(await resolveCommitIdentity(repo.clone, null, repoEntry)).toMatchObject({ source: 'repo' });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('Commit as only and nothing: today’s answers', async () => {
    const repo = repoWithConfig();
    expect(await resolveCommitIdentity(repo.clone, PROJECT)).toEqual({ ...PROJECT, source: 'project' });
    expect(await resolveCommitIdentity(repo.clone, PROJECT, null)).toEqual({ ...PROJECT, source: 'project' });
    expect(await resolveCommitIdentity(repo.clone, null)).toEqual({
      name: 'Repo Person',
      email: 'repo@example.test',
      source: 'repo',
    });
  });
});

describe('fail closed when the selected app cannot be used', () => {
  it.each([
    ['installation_suspended', APP_ERROR_TEXT.installation_suspended],
    ['repository_not_accessible', APP_ERROR_TEXT.repository_not_accessible],
    ['app_mismatch', APP_ERROR_TEXT.app_mismatch],
  ] as const)(
    '%s -> AppIdentityError naming the app and the reason, never another identity',
    async (code, text) => {
      setAppTokenProbe({
        ensure: async () => {
          throw new AppTokenError(code, 'raw provider message with secret-ish details');
        },
      });
      const repo = repoWithConfig();
      const err = await resolveCommitIdentity(repo.clone, PROJECT, appEntry).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppIdentityError);
      const e = err as AppIdentityError;
      expect(e.message).toContain('Acme bot');
      expect(e.message).toContain(text);
      expect(e.message).not.toContain('secret-ish');
      expect(appIdentityWire(e)).toMatch(/^app_identity_failed: The app Acme bot could not be used/);
      expect(identityErrorWire(e)).toBe(appIdentityWire(e));
      await expect(requireCommitIdentity(repo.clone, PROJECT, appEntry)).rejects.toBeInstanceOf(
        AppIdentityError,
      );
      await expect(rebaseEnv(repo.clone, PROJECT, appEntry)).rejects.toBeInstanceOf(AppIdentityError);
    },
  );

  it('no probe wired (old wiring): fails closed', async () => {
    const repo = repoWithConfig();
    await expect(resolveCommitIdentity(repo.clone, PROJECT, appEntry)).rejects.toThrow(/Acme bot.*too old/);
  });

  it('an app entry without the app reference fails closed', async () => {
    const repo = repoWithConfig();
    await expect(
      resolveCommitIdentity(repo.clone, PROJECT, { ...appEntry, app: undefined }),
    ).rejects.toBeInstanceOf(AppIdentityError);
  });

  it('untyped errors give the generic reason, never their own text', () => {
    expect(appReason(new Error('token ghs_abc'))).toBe(APP_ERROR_TEXT.unexpected);
    expect(appReason('x')).toBe(APP_ERROR_TEXT.unexpected);
    expect(identityErrorWire(new Error('x'))).toBeNull();
    expect(repoNameOf('github.com/acme/a.git')).toBe('acme/a');
  });
});

describe('appTokenProbe (shift-time check against the broker)', () => {
  const stored = { refs: [{ orgId: 'o', integrationId: APP_ID }] };
  const broker = (have: unknown, mint = vi.fn(async () => ({}))) => ({
    store: { get: vi.fn(() => have) } as never,
    getAccessToken: mint,
    withToken: vi.fn() as never,
  });

  it('missing key -> installation_not_found; foreign copy -> app_mismatch; else a mint scoped by repo name', async () => {
    await expect(
      appTokenProbe(broker(undefined)).ensure({ instance: '42:777', integrationId: APP_ID }, 'acme/a'),
    ).rejects.toMatchObject({
      code: 'installation_not_found',
    });
    await expect(
      appTokenProbe(broker({ refs: [{ orgId: 'o', integrationId: REPO_B }] })).ensure(
        { instance: '42:777', integrationId: APP_ID },
        'acme/a',
      ),
    ).rejects.toMatchObject({ code: 'app_mismatch' });
    const mint = vi.fn(async () => ({}));
    await appTokenProbe(broker(stored, mint)).ensure({ instance: '42:777', integrationId: APP_ID }, 'acme/a');
    expect(mint).toHaveBeenCalledWith('42:777', { repositories: ['a'] });
  });
});

describe('app.access_check', () => {
  const payload = {
    projectId: REPO_A,
    integrationId: APP_ID,
    instance: '42:777',
    host: 'github.com',
    repos: [
      { repoId: REPO_A, remoteUrlNormalized: 'github.com/Acme/A' },
      { repoId: REPO_B, remoteUrlNormalized: 'github.com/acme/b' },
    ],
  };
  const brokerWith = (
    have: unknown,
    withToken: (fn: (t: string) => Promise<unknown>) => Promise<unknown>,
  ) => ({
    store: { get: () => have } as never,
    getAccessToken: vi.fn(),
    withToken: ((_i: string, _s: unknown, fn: (t: string) => Promise<unknown>) => withToken(fn)) as never,
  });

  it('matches host and owner/name case-insensitively; never returns the token', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ repositories: [{ full_name: 'acme/a' }] })),
    );
    const r = await checkAppAccess(
      brokerWith({ refs: [{ orgId: 'o', integrationId: APP_ID }] }, (fn) => fn('ghs_secret')),
      payload,
      fetchFn as unknown as typeof fetch,
    );
    expect(r).toEqual({
      repos: [
        { repoId: REPO_A, state: 'covered' },
        { repoId: REPO_B, state: 'not_covered' },
      ],
    });
    expect(JSON.stringify(r)).not.toContain('ghs_secret');
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toContain(
      'https://api.github.com/installation/repositories',
    );
  });

  it('a broker error marks every repository error with the typed code and its sentence', async () => {
    const r = await checkAppAccess(
      brokerWith({ refs: [{ orgId: 'o', integrationId: APP_ID }] }, async () => {
        throw new AppTokenError('installation_suspended', 'x');
      }),
      payload,
      vi.fn() as unknown as typeof fetch,
    );
    expect(r.repos.every((x) => x.state === 'error' && x.code === 'installation_suspended')).toBe(true);
    expect(r.repos[0]?.detail).toBe(APP_ERROR_TEXT.installation_suspended);
  });

  it('no key on this workstation -> error, nothing fetched', async () => {
    const fetchFn = vi.fn();
    const r = await checkAppAccess(
      brokerWith(undefined, async () => ({})),
      payload,
      fetchFn as unknown as typeof fetch,
    );
    expect(r.repos[0]).toMatchObject({ state: 'error', code: 'installation_not_found' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('splitRemote', () => {
    expect(splitRemote('github.com/Acme/A.git')).toEqual({ host: 'github.com', fullName: 'acme/a' });
    expect(splitRemote('x')).toBeNull();
  });
});
