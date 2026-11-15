import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRemoteUrl, type PostAsPlan } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import type { ActorScope } from '../src/forge/app-actor.ts';
import type { AppTokenProbe } from '../src/git/identity.ts';
import { RepoCreator } from '../src/repo/create.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const APP = {
  integrationId: '0b9f3c0e-1d2a-4c1b-9a51-6f0e2a7d8c11',
  provider: 'github-app' as const,
  label: 'Guild Bot',
  botName: 'guild-bot[bot]',
  botEmail: '99+guild-bot[bot]@users.noreply.github.com',
  instance: '4242:777',
  host: 'github.com',
};
const REPO_ID = '0b9f3c0e-1d2a-4c1b-9a51-6f0e2a7d8c12';

/** A fake `gh` whose created repositories are local bare repositories (their URL is the bare path). */
function fakeGh(https = false) {
  const dir = tmp('aom-fake-gh-');
  const bin = join(dir, 'gh.sh');
  writeFileSync(
    bin,
    `#!/bin/sh
D="${dir}"
key() { echo "$1" | tr '/' '_'; }
case "$1 $2" in
  "api user") echo octo ;;
  "repo view")
    K=$(key "$3")
    if [ ! -d "$D/$K.git" ]; then echo "GraphQL: Could not resolve to a Repository with the name '$3'." >&2; exit 1; fi
    EMPTY=true
    if [ -n "$(git --git-dir="$D/$K.git" for-each-ref refs/heads)" ]; then EMPTY=false; fi
    URL="$D/$K.git"
    if [ "${https ? '1' : ''}" = 1 ]; then URL="https://github.com/$3"; fi
    echo "{\\"url\\":\\"$URL\\",\\"isEmpty\\":$EMPTY,\\"owner\\":{\\"login\\":\\"octo\\"}}" ;;
  "config get") echo "" ;;
  "repo create")
    K=$(key "$3")
    git init --bare -q "$D/$K.git" ;;
  *) echo "unexpected: $@" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, origin: (key: string) => join(dir, `${key}.git`) };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });

const payload = (postAs?: PostAsPlan) =>
  ({
    requestId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    name: 'acme/newrepo',
    visibility: 'private',
    projectKey: 'TOY',
    projectName: 'Toy project',
    branch: 'main',
    commitAs: { name: 'Owner Person', email: 'owner@example.com' },
    ...(postAs ? { postAs } : {}),
  }) as never;

function setup(
  deps: { appProbe?: AppTokenProbe; scopeFor?: (plan?: PostAsPlan | null) => ActorScope } = {},
  https = false,
) {
  const gh = fakeGh(https);
  const root = tmp('aom-root-');
  const creator = new RepoCreator({
    dir: tmp('aom-records-'),
    repoRoots: () => [root],
    ghBin: gh.bin,
    ...deps,
  });
  const origin = gh.origin('acme_newrepo');
  const remote = https ? 'https://github.com/acme/newrepo.git' : origin;
  const appPlan = (): PostAsPlan => ({
    repos: [{ repoId: REPO_ID, remoteUrlNormalized: normalizeRemoteUrl(remote), source: 'app', app: APP }],
  });
  return { creator, root, origin, appPlan };
}

const author = (bare: string) => git(bare, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main').trim();

describe('repo.create with a post-as plan', () => {
  it('makes the initial commit as the app bot when the plan posts to the new repository as an app', async () => {
    const probed: string[] = [];
    const s = setup({ appProbe: { ensure: async (_app, repo) => void probed.push(repo) } });
    const r = await s.creator.run(payload(s.appPlan()));
    expect(r).toMatchObject({ ok: true });
    expect(author(s.origin)).toBe(`${APP.botName} <${APP.botEmail}>|${APP.botName} <${APP.botEmail}>`);
    expect(author(s.origin)).not.toContain('owner@example.com');
    expect(probed).toHaveLength(1);
  });

  it('keeps the project identity without a plan, or when the repository is not on the app', async () => {
    const a = setup({ appProbe: { ensure: async () => {} } });
    expect(await a.creator.run(payload())).toMatchObject({ ok: true });
    expect(author(a.origin)).toBe('Owner Person <owner@example.com>|Owner Person <owner@example.com>');

    const b = setup({ appProbe: { ensure: async () => {} } });
    const projectOnly: PostAsPlan = {
      repos: [{ ...b.appPlan().repos[0], source: 'project' } as PostAsPlan['repos'][number]],
    };
    expect(await b.creator.run(payload(projectOnly))).toMatchObject({ ok: true });
    expect(author(b.origin)).toContain('Owner Person');
  });

  it('fails closed with the app error when the app cannot mint a token, and pushes nothing', async () => {
    const s = setup({
      appProbe: {
        ensure: async () => {
          throw Object.assign(new Error('gone'), { code: 'installation_not_found' });
        },
      },
    });
    const r = await s.creator.run(payload(s.appPlan()));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/^app_identity_failed: .*Guild Bot/);
    expect(git(s.origin, 'for-each-ref', 'refs/heads').trim()).toBe('');
  });

  it('refuses an app repository whose remote is not https before any commit is made', async () => {
    const s = setup({
      appProbe: { ensure: async () => {} },
      scopeFor: () =>
        ({
          forgeEnv: {} as never,
          auth: async () => ({ args: [], env: {} }),
          actorFor: () => ({ app: APP, repoName: 'acme/newrepo', token: async () => 'tok' }),
        }) as ActorScope,
    });
    const r = await s.creator.run(payload(s.appPlan()));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/^app_identity_failed: .*HTTPS/);
    expect(git(s.origin, 'for-each-ref', 'refs/heads').trim()).toBe('');
  });

  it('pushes the initial commit with the app credentials of the scope when the repository acts as the app', async () => {
    const used: string[] = [];
    const s = setup(
      {
        appProbe: { ensure: async () => {} },
        scopeFor: () =>
          ({
            forgeEnv: {} as never,
            auth: async (url: string) => {
              used.push(url);
              return { args: [], env: { AOM_TEST_APP_PUSH: '1' } };
            },
            actorFor: () => ({ app: APP, repoName: 'acme/newrepo', token: async () => 'tok' }),
          }) as ActorScope,
      },
      true,
    );
    // https://github.com/acme/newrepo.git is served by the local bare repository
    const saved = { ...process.env };
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${s.origin}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/acme/newrepo.git',
    });
    try {
      const r = await s.creator.run(payload(s.appPlan()));
      expect(r).toMatchObject({ ok: true, remoteUrl: 'https://github.com/acme/newrepo.git' });
    } finally {
      for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete process.env[k];
      Object.assign(process.env, saved);
    }
    expect(used).toEqual(['https://github.com/acme/newrepo.git']);
    expect(author(s.origin)).toContain(APP.botName);
  });
});
