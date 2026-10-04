import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepoCreator } from '../src/repo/create.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * A fake `gh` (nothing talks to GitHub) over a directory of bare repositories that stand in for the created origins.
 * State per repository `<owner>__<repo>`: `<dir>/<key>.git` (bare origin), `<dir>/<key>.owner`.
 */
function fakeGh(login = 'octo', protocol?: 'ssh' | 'https') {
  const dir = tmp('aom-fake-gh-');
  const bin = join(dir, 'gh.sh');
  writeFileSync(
    bin,
    `#!/bin/sh
D="${dir}"
echo "$@" >> "$D/calls.log"
key() { echo "$1" | tr '/' '_'; }
case "$1 $2" in
  "api user") echo "${login}" ;;
  "repo view")
    K=$(key "$3")
    if [ ! -d "$D/$K.git" ]; then echo "GraphQL: Could not resolve to a Repository with the name '$3'." >&2; exit 1; fi
    OWNER=$(cat "$D/$K.owner")
    EMPTY=true
    if [ -n "$(git --git-dir="$D/$K.git" for-each-ref refs/heads)" ]; then EMPTY=false; fi
    if [ -n "${protocol ?? ''}" ]; then
      echo "{\\"url\\":\\"https://github.com/$3\\",\\"sshUrl\\":\\"$D/$K.git\\",\\"isEmpty\\":$EMPTY,\\"owner\\":{\\"login\\":\\"$OWNER\\"}}"
    else
      echo "{\\"url\\":\\"$D/$K.git\\",\\"isEmpty\\":$EMPTY,\\"owner\\":{\\"login\\":\\"$OWNER\\"}}"
    fi ;;
  "config get") echo "${protocol ?? ''}" ;;
  "repo create")
    K=$(key "$3")
    git init --bare -q "$D/$K.git"
    echo "${login}" > "$D/$K.owner" ;;
  *) echo "unexpected: $@" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  const calls = () =>
    existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '';
  return { dir, bin, calls, origin: (key: string) => join(dir, `${key}.git`) };
}

const payload = (over: Record<string, unknown> = {}) =>
  ({
    requestId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    name: 'acme/newrepo',
    visibility: 'private',
    projectKey: 'TOY',
    projectName: 'Toy project',
    branch: 'main',
    ...over,
  }) as never;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });

function setup(login?: string, protocol?: 'ssh' | 'https') {
  const gh = fakeGh(login, protocol);
  const records = tmp('aom-records-');
  const root = tmp('aom-root-');
  const make = (roots: string[] = [root]) =>
    new RepoCreator({ dir: records, repoRoots: () => roots, ghBin: gh.bin });
  return { gh, records, root, make };
}

describe('repo.create on the runner', () => {
  // Real use: gh's protocol for github.com was ssh, the runner cloned the https URL and git stopped at
  // "could not read Username for 'https://github.com': terminal prompts disabled".
  it("clones with the protocol the owner's gh uses for the host (ssh), not the https URL", async () => {
    const { gh, root, make } = setup('octo', 'ssh');
    const r = await make().run(payload());
    expect(r).toMatchObject({ ok: true, remoteUrl: gh.origin('acme_newrepo') });
    expect(gh.calls()).toContain('config get git_protocol -h github.com');
    expect(git(join(root, 'newrepo'), 'remote', 'get-url', 'origin').trim()).toBe(gh.origin('acme_newrepo'));
    expect(git(gh.origin('acme_newrepo'), 'log', '--format=%s', 'main').trim()).toBe('Initial commit');
  });

  it("over https, git uses gh's login and the clone keeps it for later pushes", async () => {
    const { gh, make } = setup('octo', 'https');
    await make().run(payload());
    // https://github.com/acme/newrepo is not reachable from the test, so the clone itself fails; what matters is that
    // git asked gh for the credentials (`gh auth git-credential get`) instead of prompting for a username.
    expect(gh.calls()).toContain('auth git-credential get');
  });

  it('creates the repository with gh, makes the first commit on main, pushes and clones it under the repo root', async () => {
    const { gh, root, make } = setup();
    const r = await make().run(payload({ description: 'Hello world' }));
    expect(r).toMatchObject({ ok: true, remoteUrl: gh.origin('acme_newrepo') });
    expect(r.localPath).toBe(join(root, 'newrepo'));
    expect(gh.calls()).toContain('repo create acme/newrepo --private --description Hello world');
    expect(readFileSync(join(root, 'newrepo', 'README.md'), 'utf8')).toBe('# Toy project\n');
  });

  it('pushes main to the origin and tracks it', async () => {
    const { gh, root, make } = setup();
    await make().run(payload({ visibility: 'public' }));
    expect(gh.calls()).toContain('repo create acme/newrepo --public');
    expect(git(gh.origin('acme_newrepo'), 'log', '--format=%s', 'main').trim()).toBe('Initial commit');
    expect(git(join(root, 'newrepo'), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(join(root, 'newrepo'), 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/main');
  });

  it('is idempotent: a repeated request answers from its record and creates nothing twice', async () => {
    const { gh, make } = setup();
    const first = await make().run(payload());
    const creates = () =>
      gh
        .calls()
        .split('\n')
        .filter((l) => l.startsWith('repo create')).length;
    expect(creates()).toBe(1);
    expect(await make().run(payload())).toEqual(first); // a new executor (a runner restart) reads the record
    expect(creates()).toBe(1);
  });

  it('a retry after a partial run (repository created, no clone) reuses the empty repository', async () => {
    const { gh, root, make } = setup();
    execFileSync('git', ['init', '--bare', '-q', gh.origin('acme_newrepo')]);
    writeFileSync(join(gh.dir, 'acme_newrepo.owner'), 'octo');
    const r = await make().run(payload());
    expect(r).toMatchObject({ ok: true, existing: true });
    expect(gh.calls()).not.toContain('repo create');
    expect(existsSync(join(root, 'newrepo', 'README.md'))).toBe(true);
  });

  it('refuses a repository that exists and is not empty, or belongs to somebody else', async () => {
    const { gh, root, make } = setup();
    // not empty
    const origin = gh.origin('acme_full');
    execFileSync('git', ['init', '--bare', '-q', origin]);
    writeFileSync(join(gh.dir, 'acme_full.owner'), 'octo');
    const seed = tmp('aom-seed-');
    git(seed, 'init', '-q', '-b', 'main');
    writeFileSync(join(seed, 'a.txt'), 'x');
    git(seed, 'add', '.');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: seed });
    git(seed, 'push', origin, 'main');
    const full = await make().run(
      payload({ name: 'acme/full', requestId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2' }),
    );
    expect(full).toMatchObject({ ok: false });
    expect(full.error).toMatch(/already exists on GitHub and is not an empty repository of octo/);
    // empty but owned by another user
    execFileSync('git', ['init', '--bare', '-q', gh.origin('other_theirs')]);
    writeFileSync(join(gh.dir, 'other_theirs.owner'), 'someone-else');
    const theirs = await make().run(
      payload({ name: 'other/theirs', requestId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a3' }),
    );
    expect(theirs.ok).toBe(false);
    expect(existsSync(join(root, 'full'))).toBe(false);
    expect(existsSync(join(root, 'theirs'))).toBe(false);
  });

  it('refuses invalid names again and anything that would leave the repo root', async () => {
    const { gh, root, make } = setup();
    for (const name of ['acme/..', 'acme/x/y', 'acme', 'acme/a b', 'acme/x.git'])
      expect((await make().run(payload({ name, requestId: crypto.randomUUID() }))).ok, name).toBe(false);
    expect(gh.calls()).toBe('');
    // the clone target is a symlink that leaves the root
    const outside = tmp('aom-outside-');
    symlinkSync(outside, join(root, 'newrepo'));
    const r = await make().run(payload());
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/outside the repository root/);
    expect(gh.calls()).toBe('');
  });

  it('fails clearly without a repo root, with a missing root, without gh or when gh is not logged in', async () => {
    const { make, gh } = setup();
    expect((await make([]).run(payload())).error).toMatch(/no repository root/);
    expect((await make(['/nonexistent/aom-root']).run(payload())).error).toMatch(/does not exist/);
    const root = tmp('aom-root2-');
    const noGh = new RepoCreator({ dir: tmp(), repoRoots: () => [root], ghBin: '/nonexistent/gh' });
    expect((await noGh.run(payload())).error).toMatch(/gh is not installed/);
    writeFileSync(gh.bin, '#!/bin/sh\necho "not logged in" >&2\nexit 1\n');
    const out = await new RepoCreator({ dir: tmp(), repoRoots: () => [root], ghBin: gh.bin }).run(payload());
    expect(out.error).toMatch(/gh is not logged in/);
  });
});
