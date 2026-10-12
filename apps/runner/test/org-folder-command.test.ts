import { mkdirSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type OrgFolderState, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { RunnerConfigSchema } from '../src/config.ts';
import { changeOrgFolder, orgFolderCandidates, orgFolderStates } from '../src/org-folder.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

/** A fake home with a repo root `src` holding a group folder `acme` with two repositories, the runner dir and ~/.ssh. */
function world() {
  const home = tmp('aom-home-');
  const root = join(home, 'src');
  const acme = join(root, 'acme');
  for (const r of ['api', 'web']) {
    mkdirSync(join(acme, r), { recursive: true });
    sh(join(acme, r), 'git', ['init', '-b', 'main']);
  }
  mkdirSync(join(home, '.ssh'), { recursive: true });
  const runner = join(home, '.aom-runner');
  mkdirSync(runner, { recursive: true });
  const config = RunnerConfigSchema.parse({
    serverUrl: 'http://x',
    workstationId: 'w',
    runnerToken: 't',
    repoRoots: [root],
  });
  return { home, root, acme, runner, config };
}

const ORG = uuidv7();

describe('org folder: one validation for the CLI and the app', () => {
  it('sets a folder inside a repo root (stored as its real path) and clears it', () => {
    const w = world();
    const set = changeOrgFolder(w.config, ORG, w.acme, w.runner, w.home);
    expect(set).toMatchObject({ ok: true, path: realpathSync(w.acme) });
    if (!set.ok) return;
    expect(set.config.orgSourceFolders[ORG]).toBe(realpathSync(w.acme));
    const cleared = changeOrgFolder(set.config, ORG, null, w.runner, w.home);
    expect(cleared.ok && cleared.config.orgSourceFolders).toEqual({});
  });

  it.each([
    ['the home directory', (w: ReturnType<typeof world>) => w.home],
    ['the runner data dir', (w: ReturnType<typeof world>) => w.runner],
    ['~/.ssh', (w: ReturnType<typeof world>) => join(w.home, '.ssh')],
    ['a folder outside the repo roots', () => tmp('aom-outside-')],
    ['a repo root itself', (w: ReturnType<typeof world>) => w.root],
  ])('refuses %s', (_name, pick) => {
    const w = world();
    // a root that contains home, the runner dir and ~/.ssh makes the deny list the deciding rule
    const wide = { ...w.config, repoRoots: [w.home] };
    for (const config of _name === 'a repo root itself' ? [w.config] : [w.config, wide]) {
      const r = changeOrgFolder(config, ORG, pick(w), w.runner, w.home);
      expect(r.ok).toBe(false);
    }
  });

  it('refuses a symlink inside a root that leads out of it', () => {
    const w = world();
    const outside = tmp('aom-outside-');
    symlinkSync(outside, join(w.root, 'sneaky'));
    expect(changeOrgFolder(w.config, ORG, join(w.root, 'sneaky'), w.runner, w.home).ok).toBe(false);
  });

  it('refuses a bad organization id and a missing folder', () => {
    const w = world();
    expect(changeOrgFolder(w.config, 'nope', w.acme, w.runner, w.home).ok).toBe(false);
    expect(changeOrgFolder(w.config, ORG, join(w.root, 'missing'), w.runner, w.home).ok).toBe(false);
  });

  it('reports the state of each folder: valid with its repository count, or invalid with the reason', async () => {
    const w = world();
    const other = uuidv7();
    const config = {
      ...w.config,
      orgSourceFolders: { [ORG]: w.acme, [other]: join(w.root, 'gone') },
    };
    const states = await orgFolderStates(config, w.runner, w.home);
    expect(states.find((s) => s.orgId === ORG)).toMatchObject({ valid: true, reason: null, repoCount: 2 });
    const bad = states.find((s) => s.orgId === other);
    expect(bad?.valid).toBe(false);
    expect(bad?.reason).toContain('does not exist');
    expect(bad?.repoCount).toBe(0);
  });

  it('offers sub folders of the roots that group repositories, never a root or a repository', () => {
    const w = world();
    mkdirSync(join(w.root, 'acme', 'docs'), { recursive: true });
    const c = orgFolderCandidates(w.config, w.runner, w.home);
    expect(c).toContain(realpathSync(w.acme));
    expect(c).toContain(realpathSync(join(w.acme, 'docs')));
    expect(c).not.toContain(realpathSync(w.root));
    expect(c).not.toContain(realpathSync(join(w.acme, 'api')));
    expect(orgFolderCandidates(w.config, w.runner, w.home, 1)).toHaveLength(1);
  });
});

describe('org.folder command', () => {
  const send = (payload: Record<string, unknown>) => {
    const commandId = uuidv7();
    h?.server.send('command', { commandId, command: 'org.folder', payload });
    return h?.server.waitFor('command.result', (m) => m.commandId === commandId, 15_000);
  };

  it('sets the folder, writes config.json (mode 0600) and reports the state with the candidates', async () => {
    h = await startHarness();
    const acme = join(h.repo.scanRoot, 'acme');
    mkdirSync(join(acme, 'api'), { recursive: true });
    sh(join(acme, 'api'), 'git', ['init', '-b', 'main']);
    const r = await send({ orgId: ORG, path: acme });
    expect(r?.ok).toBe(true);
    expect(r?.result).toEqual({ ok: true });
    const file = join(h.dataDir, 'config.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).orgSourceFolders[ORG]).toBe(realpathSync(acme));
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const report = await h.server.waitFor(
      'org.folders',
      (m) => m.folders.some((f: OrgFolderState) => f.orgId === ORG && f.repoCount === 1),
      15_000,
    );
    expect(report.folders[0]).toMatchObject({ orgId: ORG, valid: true, reason: null });
    expect(report.candidates).toContain(realpathSync(acme));
    // the shift code reads the folder fresh from the config
    const cleared = await send({ orgId: ORG, path: null });
    expect(cleared?.result).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(file, 'utf8')).orgSourceFolders).toEqual({});
  });

  it('answers a refusal with the reason and leaves the config alone', async () => {
    h = await startHarness();
    const outside = tmp('aom-outside-');
    const r = await send({ orgId: ORG, path: outside });
    expect(r?.ok).toBe(true);
    expect(r?.result).toMatchObject({ ok: false });
    expect(JSON.stringify(r?.result)).toContain('repoRoots');
    expect(() => statSync(join(h?.dataDir ?? '', 'config.json'))).toThrow();
    const root = await send({ orgId: ORG, path: h.repo.scanRoot });
    expect(root?.result).toMatchObject({ ok: false });
  });

  it('reports the folders after welcome', async () => {
    h = await startHarness();
    const report = await h.server.waitFor('org.folders', () => true, 15_000);
    expect(report.folders).toEqual([]);
    expect(Array.isArray(report.candidates)).toBe(true);
  });
});
