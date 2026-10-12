import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, renderReadableFolders, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildShiftSettings } from '../src/adapters/claude-policy.ts';
import { RunnerConfigSchema, saveConfig } from '../src/config.ts';
import { checkOrgSourceFolder, mergeReadFolders, resolveOrgFolderRepos } from '../src/read-repos.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const architect = BUILTIN_ROLES.find((r) => r.key === 'architect');
if (!architect) throw new Error('architect role missing');

/** A fake home with a repoRoot `src`, an organization folder `src/acme`, the runner dir and a credentials folder. */
function world() {
  const home = tmp('aom-home-');
  const root = join(home, 'src');
  const acme = join(root, 'acme');
  mkdirSync(acme, { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });
  const runner = join(home, '.aom-runner');
  mkdirSync(runner, { recursive: true });
  const repo = (dir: string, files: Record<string, string> = { 'README.md': '# r\n' }) => {
    mkdirSync(dir, { recursive: true });
    sh(dir, 'git', ['init', '-b', 'main']);
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-m', 'init']);
    return dir;
  };
  return { home, root, acme, runner, repo };
}

describe('organization source folder: where it may point', () => {
  it('accepts a folder inside a repo root', () => {
    const w = world();
    const r = checkOrgSourceFolder(w.acme, [w.root], w.runner, w.home);
    expect(r).toMatchObject({ ok: true });
  });

  it('refuses a repo root itself, a folder outside the roots and a missing folder', () => {
    const w = world();
    expect(checkOrgSourceFolder(w.root, [w.root], w.runner, w.home)).toMatchObject({ ok: false });
    const outside = tmp('aom-outside-');
    expect(checkOrgSourceFolder(outside, [w.root], w.runner, w.home)).toMatchObject({ ok: false });
    expect(checkOrgSourceFolder(join(w.root, 'nope'), [w.root], w.runner, w.home)).toMatchObject({
      ok: false,
    });
    expect(checkOrgSourceFolder(w.acme, [], w.runner, w.home)).toMatchObject({ ok: false });
  });

  it('never the home directory, the runner data dir or a credentials folder, even when a root contains them', () => {
    const w = world();
    // a misconfigured repo root that is the home directory itself
    for (const forbidden of [w.home, w.runner, join(w.home, '.ssh'), join(w.runner, 'agents')]) {
      const r = checkOrgSourceFolder(forbidden, [w.home], w.runner, w.home);
      expect(r, forbidden).toMatchObject({ ok: false });
    }
    // a parent of the home directory
    expect(checkOrgSourceFolder(join(w.home, '..'), [join(w.home, '..')], w.runner, w.home)).toMatchObject({
      ok: false,
    });
  });

  it('compares real paths: a symlink inside a root that leads out of it is refused', () => {
    const w = world();
    const outside = tmp('aom-outside-');
    const link = join(w.root, 'sneaky');
    symlinkSync(outside, link);
    expect(checkOrgSourceFolder(link, [w.root], w.runner, w.home)).toMatchObject({ ok: false });
    const toSsh = join(w.root, 'ssh-link');
    symlinkSync(join(w.home, '.ssh'), toSsh);
    expect(checkOrgSourceFolder(toSsh, [w.root], w.runner, w.home)).toMatchObject({ ok: false });
  });
});

describe('organization source folder: what is opened', () => {
  it('opens each git repository under it, read-only folders of kind org; nothing else', async () => {
    const w = world();
    w.repo(join(w.acme, 'api'));
    w.repo(join(w.acme, 'web'));
    w.repo(join(w.acme, 'group', 'shared-lib')); // nested one level
    mkdirSync(join(w.acme, 'notes'), { recursive: true }); // not a git repository
    writeFileSync(join(w.acme, 'notes', 'todo.txt'), 'x');
    mkdirSync(join(w.acme, '.hidden', 'secret-repo'), { recursive: true });
    const out = await resolveOrgFolderRepos(w.acme, {
      repoRoots: [w.root],
      runnerRoot: w.runner,
      realHome: w.home,
    });
    expect(out.map((r) => [r.name, r.kind]).sort()).toEqual([
      ['api', 'org'],
      ['shared-lib', 'org'],
      ['web', 'org'],
    ]);
    for (const r of out) expect(r.path.startsWith(w.acme)).toBe(true);
  });

  it('opens nothing for a folder that is no longer acceptable, and skips a repository that is a symlink out', async () => {
    const w = world();
    const outside = tmp('aom-outside-');
    w.repo(outside);
    symlinkSync(outside, join(w.acme, 'linked-repo'));
    w.repo(join(w.acme, 'real'));
    const ok = await resolveOrgFolderRepos(w.acme, {
      repoRoots: [w.root],
      runnerRoot: w.runner,
      realHome: w.home,
    });
    expect(ok.map((r) => r.name)).toEqual(['real']);
    expect(
      await resolveOrgFolderRepos(w.acme, { repoRoots: [], runnerRoot: w.runner, realHome: w.home }),
    ).toEqual([]);
    expect(await resolveOrgFolderRepos(undefined, { repoRoots: [w.root], runnerRoot: w.runner })).toEqual([]);
  });

  it('merges with the registered folders without opening one twice', () => {
    type Folder = { repoId: string; name: string; kind: 'project' | 'org'; path: string };
    const a: Folder = { repoId: '1', name: 'a', kind: 'project', path: '/src/a' };
    const dup: Folder = { repoId: 'orgfolder:a', name: 'a', kind: 'org', path: '/src/a' };
    const b: Folder = { repoId: 'orgfolder:b', name: 'b', kind: 'org', path: '/src/b' };
    expect(mergeReadFolders([a], [dup, b])).toEqual([a, b]);
  });

  it('is described to the agent as a repository of the organization', () => {
    const text = renderReadableFolders([{ name: 'api', path: '/src/acme/api', kind: 'org' }]);
    expect(text).toContain('/src/acme/api (repository of the organization "api", read-only)');
  });
});

describe('organization source folder: read-only, secrets blocked (the architect policy)', () => {
  it('the folders are readable, never writable, and their secret files stay unreadable', () => {
    const w = world();
    const api = w.repo(join(w.acme, 'api'), {
      'README.md': '# api\n',
      '.env': 'TOKEN=1\n',
      'src/index.ts': 'x\n',
      'certs/server.pem': 'k\n',
    });
    const s = buildShiftSettings(
      architect.permissions,
      policyCtx({ readDirs: [api] }),
      POLICY_PATHS,
      'architect',
    );
    expect(s.permissions.additionalDirectories).toContain(api);
    // no write, by the tools or the shell
    expect(s.permissions.deny).toContain(`Edit(//${api.slice(1)}/**)`);
    expect(s.sandbox?.filesystem.denyWrite).toContain(api);
    expect(s.sandbox?.filesystem.allowWrite).not.toContain(api);
    // secret files are denied to the tools and left out of what the shell may read
    expect(s.permissions.deny).toContain(`Read(//${api.slice(1)}/**/.env)`);
    expect(s.permissions.deny).toContain(`Read(//${api.slice(1)}/**/*.pem)`);
    expect(s.sandbox?.filesystem.allowRead.some((p) => p.endsWith('.env') || p.endsWith('server.pem'))).toBe(
      false,
    );
    expect(s.sandbox?.filesystem.allowRead).toContain(join(api, 'README.md'));
    // the architect's own Edit scope stays the worktree: it can write nowhere in the folder
    expect(
      s.permissions.allow.filter((r) => r.startsWith('Edit(')).every((r) => r.includes('/data/worktrees')),
    ).toBe(true);
  });

  it('the architect cannot push, fetch, pull or touch remotes from its own shell, and cannot reset hard', () => {
    const denied = architect.permissions.deniedShellPatterns;
    for (const p of [
      'git push*',
      'git fetch*',
      'git pull*',
      'git remote*',
      'git rebase*',
      'git checkout*',
      'git switch*',
      'git reset --hard*',
    ])
      expect(denied).toContain(p);
    expect(denied).not.toContain('git merge*');
    expect(denied).not.toContain('git commit*');
    const s = buildShiftSettings(architect.permissions, policyCtx(), POLICY_PATHS, 'architect');
    expect(s.permissions.deny).toContain('Bash(git push:*)');
  });
});

describe('organization source folder: in a shift', () => {
  it('an architect shift reads the folder of its organization; a builder shift does not', async () => {
    const seen: Array<{ role: string; readDirs: string[] }> = [];
    const adapter = new ScriptedAdapter(async (i) => {
      seen.push({ role: i.agent.roleKey, readDirs: i.readDirs ?? [] });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    // the folder sits inside the runner's repo root, next to the toy clone
    const acme = join(h.repo.scanRoot, 'acme');
    const api = join(acme, 'api');
    mkdirSync(api, { recursive: true });
    sh(api, 'git', ['init', '-b', 'main']);
    writeFileSync(join(api, 'README.md'), '# api\n');
    sh(api, 'git', ['add', '-A']);
    sh(api, 'git', ['commit', '-m', 'init']);
    const orgId = uuidv7();
    // the runner re-reads config.json at each shift, so `aom-runner org-folder set` needs no restart
    saveConfig(
      join(h.dataDir, 'config.json'),
      RunnerConfigSchema.parse({
        serverUrl: h.server.url,
        workstationId: '019e3f6a-7b1c-7a2d-8c3e-0123456789b1',
        runnerToken: 'aomr_testtoken',
        runtimes: { mock: { enabled: true } },
        repoRoots: [h.repo.scanRoot],
        orgSourceFolders: { [orgId]: acme },
      }),
    );
    await h.runShift({ stage: 'investigate', startExtra: { orgId } });
    await h.runShift({ stage: 'build', ref: 'TOY-2', title: 'Other', startExtra: { orgId } });
    const arch = seen.find((s) => s.role === 'architect');
    const builder = seen.find((s) => s.role === 'builder');
    expect(arch?.readDirs.map((d) => realpathSync(d))).toContain(realpathSync(api));
    expect(builder?.readDirs).toEqual([]);
    // another organization's shift gets none of it
    await h.runShift({ stage: 'investigate', ref: 'TOY-3', title: 'Third', startExtra: { orgId: uuidv7() } });
    expect(seen.filter((s) => s.role === 'architect')[1]?.readDirs).toEqual([]);
  });
});
