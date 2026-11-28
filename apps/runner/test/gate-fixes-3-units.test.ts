import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHELL_DOMAINS } from '../src/adapters/harness-session.ts';
import { GITHUB_ASSET_HOSTS, impliedHosts } from '../src/box/egress-allow.ts';
import {
  addToolchainWriter,
  clearToolchainWriters,
  devopsSubroots,
  guardRoots,
  liveToolchainWriters,
  recipeBoxPlan,
  removeToolchainWriter,
  runnerPinnable,
  TreePins,
  toolBoxArgs,
  toolchainWriteDir,
} from '../src/box/tool-box.ts';
import { DigestCache, rootTreeHash } from '../src/box/tree-hash.ts';
import { classifyCommand, type GuardConfig } from '../src/devops/guard.ts';
import { type PolicyCliDeps, toolchainApprove, toolchainTrust } from '../src/policy/cli.ts';
import { ensurePolicyKey } from '../src/policy/integrity.ts';
import { DEFAULT_POLICY } from '../src/policy/schema.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { hostAllowed, startEgressProxy } from '../src/sandbox/egress-proxy.ts';
import { ToolchainRegistry } from '../src/toolchain/registry.ts';
import { stepRefusal } from '../src/toolchain/user-install.ts';
import { tmp } from './helpers.ts';

/** gate-fixes-3 (blocker 5): the pure parts. Egress (b), the guard's write scope (c, S3), the DevOps subroot pins and B1. */

// ---------------------------------------------------------------- egress

describe('gate-fixes-3 (b): GitHub download hosts, a fixed named list tied to github.com', () => {
  it('impliedHosts: an exact (case-folded) github.com gives the three names; *.github.com or none gives nothing', () => {
    expect(GITHUB_ASSET_HOSTS).toEqual([
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com',
      'codeload.github.com',
    ]);
    expect(impliedHosts(['GitHub.com'])).toEqual([...GITHUB_ASSET_HOSTS]);
    expect(impliedHosts(['*.github.com'])).toEqual([]);
    expect(impliedHosts(['gitlab.com', 'evil.com'])).toEqual([]);
    expect(impliedHosts([])).toEqual([]);
  });

  const connectStatus = (socketPath: string, host: string): Promise<string> =>
    new Promise((resolve) => {
      const c = connect(socketPath);
      let buf = '';
      c.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('\r\n')) {
          c.destroy();
          resolve(buf.split('\r\n')[0] ?? '');
        }
      });
      c.on('error', () => resolve(buf));
      c.on('close', () => resolve(buf.split('\r\n')[0] ?? ''));
      c.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });

  it('the proxy: the outer list reaches release-assets; raw, gist and evil.com get 403; the inner list (no implied hosts) refuses release-assets', async () => {
    const outer = [...SHELL_DOMAINS, ...impliedHosts(SHELL_DOMAINS)];
    expect(hostAllowed('release-assets.githubusercontent.com', outer)).toBe(true);
    expect(hostAllowed('release-assets.githubusercontent.com', [...SHELL_DOMAINS])).toBe(false);
    // without github.com in the list nothing is implied (unit level only: github.com is on every base list, DESIGN S1)
    const noGithub = SHELL_DOMAINS.filter((h) => h !== 'github.com');
    expect(
      hostAllowed('release-assets.githubusercontent.com', [...noGithub, ...impliedHosts(noGithub)]),
    ).toBe(false);
    for (const [list, host] of [
      [outer, 'raw.githubusercontent.com'],
      [outer, 'gist.githubusercontent.com'],
      [outer, 'evil.com'],
      [outer, 'uploads.github.com'],
      [[...SHELL_DOMAINS], 'release-assets.githubusercontent.com'],
    ] as const) {
      const s = join(mkdtempSync(join(tmpdir(), 'aom-gf3-')), 'p.sock');
      const proxy = await startEgressProxy({ socketPath: s, allowedHosts: [...list] });
      try {
        expect(await connectStatus(s, host), host).toContain('403');
      } finally {
        await proxy.close();
      }
    }
  });
});

// ---------------------------------------------------------------- the guard's write scope

describe('gate-fixes-3 (c), S3: the guard lets an outside run write only new DevOps tool versions', () => {
  const HOME = '/home/u';
  const TC = `${HOME}/.local/share/guildwise/toolchains`;
  const cfg = (tw: boolean, over: Partial<GuardConfig> = {}): GuardConfig => ({
    sessionRef: 's',
    kind: 'shift',
    deleteRoots: [],
    home: HOME,
    protectedBranches: [],
    approvedCommands: [],
    access: { allowInstall: false, allowDocker: false, allowedPaths: [] },
    writeRoots: ['/tmp', ...(tw ? [`${TC}/devops`] : [])],
    ...(tw
      ? { toolchainWrite: { roots: [TC], dirs: [`${TC}/devops`], pinned: [`${TC}/devops/jq/1.6`] } }
      : {}),
    ...over,
  });
  const v = (cmd: string, tw = true) => classifyCommand(cmd, cfg(tw), '/tmp/work', {});

  it('mkdir -p and cp into an unpinned devops/<tool>/<version> are allowed', () => {
    expect(v('mkdir -p ~/.local/share/guildwise/toolchains/devops/jq/1.7')).toMatchObject({
      decision: 'allowed',
    });
    expect(v(`mkdir -p ${TC}/devops/jq/1.7 && cp /tmp/jq ${TC}/devops/jq/1.7/jq`)).toMatchObject({
      decision: 'allowed',
    });
  });

  it('toolchain_fixed (no switch, so no Desk item) for the tool folder outside devops, a .. escape and a pinned version', () => {
    for (const cmd of [
      'mkdir -p ~/.local/share/guildwise/toolchains/bun/1.4.5',
      `mkdir -p ${TC}/devops/../node/x`,
      `cp /tmp/jq ${TC}/devops/jq/1.6/jq`,
      `echo x > ${TC}/devops/jq/1.6/extra`,
    ]) {
      const r = v(cmd);
      expect(r, cmd).toMatchObject({ decision: 'refused', rule: 'toolchain_fixed' });
      expect(r.reason, cmd).toContain('No approval opens it');
    }
    // an approval of the exact command does not lift it either
    const approved = `mkdir -p ${TC}/bun/1.4.5`;
    expect(
      classifyCommand(approved, cfg(true, { approvedCommands: [approved] }), '/tmp/work', {}),
    ).toMatchObject({ rule: 'toolchain_fixed' });
  });

  it('AC3: the paths switch for ~/.local/bin, a sibling toolchains2 and anything without the toolchain write', () => {
    expect(v('cp /tmp/jq ~/.local/bin/jq')).toMatchObject({ decision: 'refused', rule: 'paths' });
    expect(v(`mkdir -p ${HOME}/.local/share/guildwise/toolchains2/devops/x`)).toMatchObject({
      decision: 'refused',
      rule: 'paths',
    });
    expect(v(`mkdir -p ${HOME}/.local/share/guildwise/other`)).toMatchObject({ rule: 'paths' });
    expect(v(`mkdir -p ${TC}/devops/jq/1.7`, false)).toMatchObject({ decision: 'refused', rule: 'paths' });
    expect(v(`mkdir -p ${HOME}/.cargo/x`)).toMatchObject({ decision: 'refused', rule: 'paths' });
  });
});

// ---------------------------------------------------------------- the toolchain write folder

describe('gate-fixes-3 (c): the toolchain write follows the "download tools" tick', () => {
  it('<tcRoot>/devops only with toolInstall and setup done', () => {
    expect(toolchainWriteDir({ toolInstall: true, setupDone: true }, '/t')).toBe('/t/devops');
    expect(toolchainWriteDir({ toolInstall: false, setupDone: true }, '/t')).toBeNull();
    expect(toolchainWriteDir({ toolInstall: true, setupDone: false }, '/t')).toBeNull();
    expect(toolchainWriteDir({ setupDone: true }, '/t')).toBeNull();
  });
});

// ---------------------------------------------------------------- pins

const cache = () => new DigestCache();
const hashOf = (root: string, exclude?: string[]) =>
  rootTreeHash(root, { cache: cache(), racyMs: 0, ...(exclude ? { exclude } : {}) });

function toolFolder() {
  const tc = join(tmp(), 'toolchains');
  mkdirSync(join(tc, 'node', 'bin'), { recursive: true });
  writeFileSync(join(tc, 'node', 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
  return tc;
}

function devopsTool(tc: string, tool: string, version: string, content = 'v1\n'): string {
  const d = join(tc, 'devops', tool, version);
  mkdirSync(join(d, 'bin'), { recursive: true });
  writeFileSync(join(d, 'bin', tool), content, { mode: 0o755 });
  return d;
}

describe('gate-fixes-3 pins: devops/ is left out of the tool folder hash and pinned per <tool>/<version>', () => {
  it('the tool folder hash is the same with devops/ absent or present; a write in a subroot changes only that subroot', () => {
    const tc = toolFolder();
    const ex = [join(tc, 'devops')];
    const before = hashOf(tc);
    expect(before.kind).toBe('ok');
    expect(hashOf(tc, ex)).toEqual(before);
    const jq = devopsTool(tc, 'jq', '1.7');
    const other = devopsTool(tc, 'other', '2.0');
    expect((hashOf(tc, ex) as { hash: string }).hash).toBe((before as { hash: string }).hash);
    expect((hashOf(tc) as { hash: string }).hash).not.toBe((before as { hash: string }).hash);
    const otherBefore = hashOf(other);
    writeFileSync(join(jq, 'bin', 'jq'), 'v2\n', { mode: 0o755 });
    expect((hashOf(tc, ex) as { hash: string }).hash).toBe((before as { hash: string }).hash);
    expect(hashOf(other)).toEqual(otherBefore);
  });

  it('S4: an unpinned tool folder that is empty after the exclusion reports absent (no trust step on a fresh machine)', () => {
    const tc = join(tmp(), 'toolchains');
    mkdirSync(join(tc, 'devops'), { recursive: true });
    const pins = new TreePins(tmp(), () => {}, { memoryCache: true, racyMs: 0, toolchainsRoot: tc });
    expect(pins.status(tc).state).toBe('absent');
    writeFileSync(join(tc, 'loose'), 'x');
    pins.clearMemo();
    expect(pins.status(tc).state).toBe('unpinned');
  });

  it('links: a subroot linking to tcRoot/node fails; tcRoot linking into devops/ fails', () => {
    const tc = toolFolder();
    const jq = devopsTool(tc, 'jq', '1.7');
    symlinkSync(join(tc, 'node', 'bin', 'node'), join(jq, 'bin', 'node'));
    expect(hashOf(jq).kind).toBe('fail');
    const tc2 = toolFolder();
    devopsTool(tc2, 'jq', '1.7');
    symlinkSync(join(tc2, 'devops', 'jq', '1.7', 'bin', 'jq'), join(tc2, 'node', 'bin', 'jq'));
    expect(hashOf(tc2, [join(tc2, 'devops')]).kind).toBe('fail');
  });

  it('guardRoots lists real devops/<tool>/<version> folders only; the runner never pins a subroot', () => {
    const tc = toolFolder();
    const jq = devopsTool(tc, 'jq', '1.7');
    writeFileSync(join(tc, 'devops', 'loose'), 'x');
    mkdirSync(join(tc, 'devops', 'Bad Name', '1'), { recursive: true });
    symlinkSync(jq, join(tc, 'devops', 'jq', 'latest'));
    expect(devopsSubroots(tc)).toEqual([jq]);
    const g = guardRoots(tmp(), tc);
    expect(g.whole).toEqual([tc, jq]);
    expect(g.subroots).toEqual([jq]);
    expect(runnerPinnable(g)).toEqual([tc]);
    expect(g.exclude).toEqual({ [tc]: [join(tc, 'devops')] });
  });

  it('N5: ok/pathOk use the longest root and never fall back to the tool folder pin for devops/ paths outside a subroot', () => {
    const tc = toolFolder();
    const jq = devopsTool(tc, 'jq', '1.7');
    writeFileSync(join(tc, 'devops', 'loose'), 'x');
    mkdirSync(join(tc, 'devops', 'Bad Name', 'bin'), { recursive: true });
    symlinkSync(join(jq, 'bin'), join(tc, 'devops', 'link'));
    const dir = tmp();
    ensurePolicyKey(dir);
    const pins = new TreePins(dir, () => {}, { memoryCache: true, racyMs: 0, toolchainsRoot: tc });
    const g = guardRoots(tmp(), tc);
    pins.pin([tc]);
    expect(pins.ok(join(tc, 'node', 'bin'), g)).toBe(true);
    // the subroot is not pinned yet: its tools are off
    expect(pins.ok(join(jq, 'bin'), g)).toBe(false);
    for (const p of [
      join(tc, 'devops', 'loose'),
      join(tc, 'devops', 'link'),
      join(tc, 'devops', 'Bad Name', 'bin'),
      join(tc, 'devops', 'jq'),
    ]) {
      expect(pins.ok(p, g), p).toBe(false);
      expect(pins.pathOk(p, g), p).toBe(false);
    }
    pins.pin([jq]);
    expect(pins.ok(join(jq, 'bin'), g)).toBe(true);
    expect(pins.pinnedSubroots()).toEqual([jq]);
    // a write in the pinned subroot turns it off; the tool folder stays on
    writeFileSync(join(jq, 'bin', 'jq'), 'changed\n', { mode: 0o755 });
    pins.clearMemo();
    expect(pins.ok(join(jq, 'bin'), g)).toBe(false);
    expect(pins.status(jq).state).toBe('changed');
    expect(pins.ok(join(tc, 'node', 'bin'), g)).toBe(true);
  });

  it('the recipe box binds devops read-only and keeps it off its PATH; a step naming it is refused', () => {
    const tc = toolFolder();
    devopsTool(tc, 'jq', '1.7');
    const home = tmp();
    const plan = recipeBoxPlan([tc], tc, home);
    const args = toolBoxArgs(plan, undefined);
    const at = (flag: string, p: string) => args.findIndex((a, i) => a === flag && args[i + 1] === p);
    expect(at('--bind', tc)).toBeGreaterThan(-1);
    expect(at('--ro-bind', join(tc, 'devops'))).toBeGreaterThan(at('--bind', tc));
    expect(plan.noPath).toContain(join(tc, 'devops'));
    const guard = { roots: [tc], before: [tc], exclude: [join(tc, 'devops')] };
    expect(stepRefusal({ cmd: 'tar', args: ['-C', join(tc, 'devops', 'jq'), '-x'] }, guard)).toContain(
      'DevOps tools',
    );
    expect(stepRefusal({ cmd: 'tar', args: ['-C', join(tc, 'go'), '-x'] }, guard)).toBeNull();
  });
});

// ---------------------------------------------------------------- B1, R2-2: approve and trust

describe('gate-fixes-3 B1: the writer lock', () => {
  it('per shift; one run ending keeps the other; a dead pid is not live; clearing keeps only this process', () => {
    const dir = tmp();
    addToolchainWriter(dir, 'a');
    addToolchainWriter(dir, 'b');
    expect(liveToolchainWriters(dir).sort()).toEqual(['a', 'b']);
    removeToolchainWriter(dir, 'a');
    expect(liveToolchainWriters(dir)).toEqual(['b']);
    addToolchainWriter(dir, 'dead', 2 ** 22 + 12345);
    expect(liveToolchainWriters(dir)).toEqual(['b']);
    clearToolchainWriters(dir);
    expect(JSON.parse(readFileSync(join(dir, 'toolchain-writer.lock'), 'utf8')).writers).toEqual([
      { pid: process.pid, shiftId: 'b' },
    ]);
    removeToolchainWriter(dir, 'b');
    expect(liveToolchainWriters(dir)).toEqual([]);
  });
});

function approveWorld() {
  const pdir = tmp();
  ensurePolicyKey(pdir);
  const store = new PolicyStore(pdir);
  store.write(DEFAULT_POLICY);
  const tc = toolFolder();
  const jq = devopsTool(tc, 'jq', '1.7');
  for (const d of [tc, join(tc, 'devops'), join(tc, 'devops', 'jq'), jq]) chmodSync(d, 0o755);
  const regRoot = tmp();
  const reg = new ToolchainRegistry(
    join(regRoot, 'toolchains.json'),
    regRoot,
    () => ({ toolchainPaths: [] }),
    tmp(),
  );
  reg.pinned = (h) => store.get().toolchainPins.includes(h);
  reg.add({ name: 'jq', bin: [join(jq, 'bin')] }, 'devops');
  const hash = reg.waiting()[0]?.hash as string;
  const pins = new TreePins(pdir, () => {}, { memoryCache: true, racyMs: 0, toolchainsRoot: tc });
  const out: string[] = [];
  const d = {
    store,
    out: (l: string) => out.push(l),
    toolchains: () => reg,
    treePins: () => pins,
    guardRoots: () => guardRoots(tmp(), tc),
    logsDir: () => tmp(),
  } as unknown as PolicyCliDeps;
  return { pdir, store, tc, jq, reg, hash, pins, out, d };
}

describe('gate-fixes-3: `toolchain approve` pins the DevOps tool folder with its entry', () => {
  it('one typed yes pins the subroot (expect) and the entry; the contents are shown', async () => {
    const w = approveWorld();
    await toolchainApprove({ ...w.d, ask: async () => 'yes' }, w.hash);
    expect(w.store.get().toolchainPins).toEqual([w.hash]);
    expect(w.pins.read().roots[w.jq]).toBeDefined();
    expect(w.out.join('\n')).toContain('bin/jq');
  });

  it('refused while a DevOps writer lives, for a subroot that cannot be allowed, and when the content changes while asking', async () => {
    const w = approveWorld();
    addToolchainWriter(w.pdir, 'running');
    await expect(toolchainApprove({ ...w.d, ask: async () => 'yes' }, w.hash)).rejects.toThrow(
      /still be writing/,
    );
    removeToolchainWriter(w.pdir, 'running');
    expect(w.store.get().toolchainPins).toEqual([]);

    // the writer starts while the owner reads the prompt
    await expect(
      toolchainApprove(
        {
          ...w.d,
          ask: async () => {
            addToolchainWriter(w.pdir, 'late');
            return 'yes';
          },
        },
        w.hash,
      ),
    ).rejects.toThrow(/still be writing/);
    removeToolchainWriter(w.pdir, 'late');

    // changed while asked
    await expect(
      toolchainApprove(
        {
          ...w.d,
          ask: async () => {
            writeFileSync(join(w.jq, 'bin', 'jq'), 'swapped\n', { mode: 0o755 });
            return 'yes';
          },
        },
        w.hash,
      ),
    ).rejects.toThrow(/changed while you looked/);
    expect(w.store.get().toolchainPins).toEqual([]);
    expect(w.pins.read().roots[w.jq]).toBeUndefined();

    // a link out of the folder (to a folder of this account): refused with its reason
    symlinkSync(tmp(), join(w.jq, 'bin', 'out'));
    await expect(toolchainApprove({ ...w.d, ask: async () => 'yes' }, w.hash)).rejects.toThrow(
      /cannot be allowed/,
    );
  });
});

describe('gate-fixes-3 R2-2: `toolchain trust` never pins a new DevOps tool folder, and none while a writer lives', () => {
  it('an unpinned subroot is refused (approve is the way); a changed pinned one is refused while a writer lives, trusted after', async () => {
    const w = approveWorld();
    const code = (w.pins.fullHash(w.jq) as { hash: string }).hash;
    await expect(toolchainTrust({ ...w.d, ask: async () => 'yes' }, code)).rejects.toThrow(
      /toolchain approve/,
    );
    expect(w.pins.read().roots[w.jq]).toBeUndefined();
    // pinned, then changed: the trust step's case
    w.pins.pin([w.jq]);
    writeFileSync(join(w.jq, 'bin', 'jq'), 'v2\n', { mode: 0o755 });
    const changed = (w.pins.fullHash(w.jq) as { hash: string }).hash;
    addToolchainWriter(w.pdir, 'running');
    await expect(toolchainTrust({ ...w.d, ask: async () => 'yes' }, changed)).rejects.toThrow(
      /still be writing/,
    );
    removeToolchainWriter(w.pdir, 'running');
    await toolchainTrust({ ...w.d, ask: async () => 'yes' }, changed);
    expect(w.pins.read().roots[w.jq]).toBe(changed);
  });
});

describe('gate-fixes-3 (S2): the catalogue `aom toolchain ensure` accepts', () => {
  it('ids or one matching name; only code-pinned tools install without the project using them', async () => {
    const { catalogueToolId, versionPinnedToolNames, TOOLS } = await import('../src/toolchain/stacks.ts');
    expect(catalogueToolId('bun')).toBe('node-bun');
    expect(catalogueToolId('node-bun')).toBe('node-bun');
    expect(catalogueToolId('UV')).toBe('python-uv');
    expect(catalogueToolId('foo')).toBeNull();
    expect(versionPinnedToolNames().sort()).toEqual(
      ['Android SDK command-line tools', 'Bun', 'Gradle', 'Maven', 'uv'].sort(),
    );
    for (const id of ['node', 'go', 'jdk', 'rust', 'dotnet-sdk'])
      expect(TOOLS[id]?.versionPinned, id).toBeFalsy();
  });
});

describe('gate-fixes-3: the DevOps notes point at the one-question paths', () => {
  it('in the box: catalogued tools through toolchain ensure first; outside: the new devops/<tool>/<version> folder', async () => {
    const { DEVOPS_BOX_NOTE, devopsOutsideNote } = await import('../src/devops/requests.ts');
    expect(DEVOPS_BOX_NOTE).toMatch(/Bun.*use it FIRST/s);
    expect(DEVOPS_BOX_NOTE).toContain('goes to `aom devops-outside` at once');
    expect(devopsOutsideNote('yes', '/t/devops')).toContain('/t/devops/<tool>/<version>');
    expect(devopsOutsideNote('yes', '/t/devops')).toContain('aom toolchain add');
    expect(devopsOutsideNote('yes')).toContain('does not let DevOps download tools');
  });
});

describe('gate-fixes-3 REVIEW S-2: tool-folder paths the guard does not parse as write targets', () => {
  const HOME = '/home/u';
  const TC = `${HOME}/.local/share/guildwise/toolchains`;
  const cfg = {
    home: HOME,
    toolchainWrite: { roots: [TC], dirs: [`${TC}/devops`], pinned: [`${TC}/devops/jq/1.6`] },
  };
  it('curl -o, tar -C and unzip -d into the tool folder outside devops/ or into a pinned version are named; devops/<new> and elsewhere are not', async () => {
    const { toolchainFixedPath } = await import('../src/devops/guard.ts');
    expect(toolchainFixedPath(`curl -L -o ${TC}/bun/bun https://github.com/x`, cfg)).toBe(`${TC}/bun/bun`);
    expect(toolchainFixedPath('tar -xzf /tmp/b.tgz -C ~/.local/share/guildwise/toolchains', cfg)).toBe(TC);
    expect(
      toolchainFixedPath(`unzip -d "$HOME/.local/share/guildwise/toolchains/devops/../node" x.zip`, cfg),
    ).toBe(`${TC}/devops/../node`);
    expect(toolchainFixedPath(`curl -o ${TC}/devops/jq/1.6/jq https://x`, cfg)).toBe(
      `${TC}/devops/jq/1.6/jq`,
    );
    expect(toolchainFixedPath(`curl -L -o ${TC}/devops/jq/1.7/jq https://x`, cfg)).toBeNull();
    expect(toolchainFixedPath(`tar -C ${HOME}/.local/share/guildwise/toolchains2 -x`, cfg)).toBeNull();
    expect(toolchainFixedPath('curl -o /tmp/jq https://x', cfg)).toBeNull();
    expect(toolchainFixedPath(`curl -o ${TC}/bun/bun https://x`, { home: HOME })).toBeNull();
  });
});
