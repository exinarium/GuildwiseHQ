import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bwrapArgs, type SandboxSpec, sandboxCommand } from '../src/runs/sandbox.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/** A fake host: `<root>/run/systemd/{resolve,private,journal,notify}`, `<root>/etc/resolv.conf` and a runner root. */
function host(kind: 'stub' | 'plain' | 'dangling' | 'missing' | 'in-runner' | 'dir') {
  const root = tmp('dns');
  const sys = join(root, 'run', 'systemd');
  for (const d of ['resolve', 'private', 'journal', 'notify']) mkdirSync(join(sys, d), { recursive: true });
  mkdirSync(join(root, 'etc'), { recursive: true });
  const runnerRoot = join(root, 'runner');
  mkdirSync(runnerRoot, { recursive: true });
  for (const d of ['wt', 'cache', 'rt', 'home']) mkdirSync(join(root, d), { recursive: true });
  const stub = join(sys, 'resolve', 'stub-resolv.conf');
  const conf = join(root, 'etc', 'resolv.conf');
  if (kind === 'stub') {
    writeFileSync(stub, 'nameserver 127.0.0.53\n');
    symlinkSync(stub, conf);
  } else if (kind === 'plain') {
    writeFileSync(conf, 'nameserver 1.1.1.1\n');
  } else if (kind === 'dangling') {
    symlinkSync(join(sys, 'resolve', 'gone.conf'), conf);
  } else if (kind === 'in-runner') {
    writeFileSync(join(runnerRoot, 'resolv.conf'), 'nameserver 1.1.1.1\n');
    symlinkSync(join(runnerRoot, 'resolv.conf'), conf);
  } else if (kind === 'dir') {
    symlinkSync(join(sys, 'resolve'), conf);
  }
  const spec: SandboxSpec = {
    runnerRoot,
    realHome: join(root, 'home'),
    worktrees: [join(root, 'wt')],
    cacheRoot: join(root, 'cache'),
    runTmp: join(root, 'rt'),
    uid: 424242,
    resolvConf: conf,
    systemMasks: [sys],
  };
  return { spec, sys, stub };
}

const binds = (args: string[]): string[] =>
  args.flatMap((a, i) => (a === '--ro-bind' && args[i + 1] !== '/' ? [args[i + 1] as string] : []));

describe('run sandbox DNS', () => {
  it('binds only the resolved file when resolv.conf links into the masked /run/systemd', () => {
    const { spec, sys, stub } = host('stub');
    const c = sandboxCommand(spec, ['true']);
    expect(c.warning).toBeUndefined();
    const a = c.args;
    expect(a).toContain('--tmpfs');
    expect(binds(a)).toContain(stub);
    const tmpfsAt = a.findIndex((x, i) => x === '--tmpfs' && a[i + 1] === sys);
    const bindAt = a.findIndex((x, i) => x === '--ro-bind' && a[i + 1] === stub && a[i + 2] === stub);
    expect(tmpfsAt).toBeGreaterThan(-1);
    expect(bindAt).toBeGreaterThan(tmpfsAt);
    for (const hidden of ['private', 'journal', 'notify', 'resolve']) {
      expect(a).not.toContain(join(sys, hidden));
    }
    expect(a.some((x) => x.includes('io.systemd.Resolve'))).toBe(false);
  });

  it('adds no binding for a plain resolv.conf', () => {
    const { spec, sys } = host('plain');
    const c = sandboxCommand(spec, ['true']);
    expect(c.warning).toBeUndefined();
    expect(c.args.filter((x) => x.startsWith(sys) && x !== sys)).toEqual([]);
    expect(binds(c.args)).toEqual([]);
  });

  it('warns and binds nothing for a dangling link into the mask', () => {
    const { spec, sys } = host('dangling');
    const c = sandboxCommand(spec, ['true']);
    expect(c.warning).toMatch(/^run sandbox: DNS unavailable, .*resolv\.conf points into masked /);
    expect(c.args.filter((x) => x.startsWith(sys) && x !== sys)).toEqual([]);
    expect(c.args.at(-2)).toBe('--');
  });

  it('warns for a missing resolv.conf', () => {
    const { spec } = host('missing');
    const c = sandboxCommand(spec, ['true']);
    expect(c.warning).toMatch(/DNS unavailable.*does not exist/);
  });

  it('never binds a folder, only a regular file', () => {
    const { spec, sys } = host('dir');
    const c = sandboxCommand(spec, ['true']);
    expect(c.warning).toMatch(/not a regular file/);
    expect(c.args.filter((x) => x.startsWith(sys) && x !== sys)).toEqual([]);
  });

  it('does not reopen a target inside another masked path', () => {
    const { spec } = host('in-runner');
    const c = sandboxCommand(spec, ['true']);
    expect(c.warning).toMatch(/DNS unavailable/);
    expect(binds(c.args).some((b) => b.startsWith(spec.runnerRoot))).toBe(false);
  });

  it('network none stays offline: no bind, no warning', () => {
    for (const kind of ['stub', 'dangling'] as const) {
      const { spec, sys } = host(kind);
      const c = sandboxCommand({ ...spec, network: 'none' }, ['true']);
      expect(c.warning).toBeUndefined();
      expect(c.args).toContain('--unshare-net');
      expect(c.args.filter((x) => x.startsWith(sys) && x !== sys)).toEqual([]);
    }
  });

  it('bwrapArgs matches the command arguments', () => {
    const { spec } = host('stub');
    expect(sandboxCommand(spec, ['x']).args.slice(0, -2)).toEqual(bwrapArgs(spec));
  });
});
