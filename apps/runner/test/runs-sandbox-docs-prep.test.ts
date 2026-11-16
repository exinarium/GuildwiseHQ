import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bwrapArgs, gitDirOf, maskedPaths, type SandboxSpec } from '../src/runs/sandbox.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/** What bwrapArgs returned before the optional docs-prep fields existed (the run step / service / check profile). */
function legacyArgs(spec: SandboxSpec): string[] {
  const args = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--unshare-pid',
    '--unshare-ipc',
    ...(spec.network === 'none' ? ['--unshare-net'] : []),
    '--cap-drop',
    'ALL',
  ];
  for (const p of maskedPaths({ runnerRoot: spec.runnerRoot, realHome: spec.realHome, uid: spec.uid })) {
    if (lstatSync(p).isDirectory()) args.push('--tmpfs', p);
    else args.push('--ro-bind', '/dev/null', p);
  }
  for (const g of spec.gitDirs ?? []) if (existsSync(g)) args.push('--ro-bind', g, g);
  args.push('--bind', spec.runTmp, '/tmp');
  for (const w of [...spec.worktrees, spec.cacheRoot]) args.push('--bind', w, w);
  const secrets = join(spec.realHome, '.microsoft', 'usersecrets');
  if (spec.userSecrets !== false && existsSync(secrets))
    args.push('--ro-bind', secrets, '/tmp/home/.microsoft/usersecrets');
  return args;
}

function fixture() {
  const home = tmp();
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.npmrc'), 'x');
  mkdirSync(join(home, '.microsoft', 'usersecrets'), { recursive: true });
  const machine = tmp();
  const root = join(machine, 'pairings', 'p1');
  mkdirSync(join(machine, 'pairings', 'p2'), { recursive: true });
  mkdirSync(join(root, 'cache'), { recursive: true });
  const gitDir = tmp();
  // a plain resolver file: the DNS bind (GWP-247) depends on the host's /etc/resolv.conf, so the test does not
  const resolvConf = join(tmp(), 'resolv.conf');
  writeFileSync(resolvConf, 'nameserver 1.1.1.1\n');
  const spec: SandboxSpec = {
    resolvConf,
    runnerRoot: root,
    realHome: home,
    worktrees: [join(root, 'wt')],
    cacheRoot: join(root, 'cache'),
    runTmp: '/tmp/aom-run-x',
    gitDirs: [gitDir],
    uid: 1000,
  };
  return { home, machine, root, spec };
}

describe('sandbox profile: optional docs-prep fields', () => {
  it('without the new fields the arguments are unchanged for every current caller', () => {
    const { spec } = fixture();
    for (const s of [
      spec,
      { ...spec, network: 'none' as const },
      { ...spec, userSecrets: false },
      { ...spec, network: 'host' as const, gitDirs: [] },
    ]) {
      expect(bwrapArgs(s)).toEqual(legacyArgs(s));
      expect(bwrapArgs({ ...s, extraMasked: [], dieWithParent: false })).toEqual(legacyArgs(s));
    }
  });

  it('dieWithParent adds --die-with-parent', () => {
    const { spec } = fixture();
    expect(bwrapArgs(spec)).not.toContain('--die-with-parent');
    expect(bwrapArgs({ ...spec, dieWithParent: true })).toContain('--die-with-parent');
  });

  it('extraMasked masks those paths first and skips ones that do not exist', () => {
    const { spec, machine, root } = fixture();
    const missing = join(machine, 'nope');
    const m = maskedPaths({ ...spec, extraMasked: [missing, machine] });
    expect(m[0]).toBe(machine);
    expect(m).not.toContain(missing);
    expect(m).toContain(root);
    const a = bwrapArgs({ ...spec, extraMasked: [machine] });
    const at = (flag: string, p: string) => a.findIndex((x, k) => x === flag && a[k + 1] === p);
    expect(at('--tmpfs', machine)).toBeGreaterThan(-1);
    expect(at('--tmpfs', machine)).toBeLessThan(at('--tmpfs', root));
    // the worktree and caches are bound back after every mask
    expect(at('--tmpfs', root)).toBeLessThan(a.indexOf('--bind'));
  });
});

describe('gitDirOf', () => {
  it("reads the clone's git dir of a linked worktree, and nothing for a plain folder", () => {
    const wt = tmp();
    writeFileSync(join(wt, '.git'), 'gitdir: /repo/.git/worktrees/wt\n');
    expect(gitDirOf(wt)).toEqual(['/repo/.git']);
    expect(gitDirOf(tmp())).toEqual([]);
  });
});
