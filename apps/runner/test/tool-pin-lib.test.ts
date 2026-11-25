import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { EnvEnsurePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  binTrustCode,
  depsBoxPlan,
  type GuardRoots,
  recipeBoxPlan,
  refusedCode,
  TREE_PINS_FILE,
  TreePins,
  toolBoxArgs,
} from '../src/box/tool-box.ts';
import { DigestCache, rootTreeHash } from '../src/box/tree-hash.ts';
import { findPackageManager, type ToolGate } from '../src/devops/dependency-install.ts';
import { type PolicyCliDeps, toolchainTrust } from '../src/policy/cli.ts';
import { ensurePolicyKey, seal } from '../src/policy/integrity.ts';
import { selectDotnet } from '../src/toolchain/dotnet.ts';
import {
  type EnsureDeps,
  ensureEnvironment,
  rustToolchainRequest,
  TOOL_FOLDER_CHANGED,
} from '../src/toolchain/ensure.ts';
import {
  ensureBusy,
  holdForRestart,
  noteOutside,
  outsideState,
  resetEnsureLockForTests,
  runningBefore,
  setRunning,
  withEnsureLock,
} from '../src/toolchain/ensure-lock.ts';
import type { ExecOptions, ExecResult, Executor } from '../src/toolchain/exec.ts';
import { keepingToolPin } from '../src/toolchain/extras.ts';
import { ToolchainRegistry } from '../src/toolchain/registry.ts';
import { uvEnv } from '../src/toolchain/sources.ts';
import { installerExecutor, stepRefusal } from '../src/toolchain/user-install.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * tool-pin-lib: the Guildwise tool folder is pinned as a whole (every file and link), links out of it are refused unless
 * they reach a read-only system path, and the user's own tool folders keep their bin pins (S1).
 */

/** A Guildwise tool folder with the Node layout `nodeUserInstall` makes: `<root>/node/<v>` plus `<root>/bin` links. */
function nodeRoot(): { root: string; npmCli: string; lib: string; bin: string } {
  const root = join(realpathSync(tmp('aom-tpl-')), 'toolchains');
  const v = join(root, 'node', '22.1.0');
  const npmDir = join(v, 'lib', 'node_modules', 'npm');
  mkdirSync(join(npmDir, 'bin'), { recursive: true });
  mkdirSync(join(v, 'bin'), { recursive: true });
  writeFileSync(join(v, 'bin', 'node'), '#!/bin/sh\necho node\n', { mode: 0o755 });
  const npmCli = join(npmDir, 'bin', 'npm-cli.js');
  writeFileSync(npmCli, '#!/usr/bin/env node\nconsole.log("npm")\n', { mode: 0o755 });
  writeFileSync(join(npmDir, 'package.json'), '{"name":"npm"}\n');
  symlinkSync(join('..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(v, 'bin', 'npm'));
  mkdirSync(join(root, 'bin'));
  // `linkInto` writes absolute targets
  symlinkSync(join(v, 'bin', 'node'), join(root, 'bin', 'node'));
  symlinkSync(join(v, 'bin', 'npm'), join(root, 'bin', 'npm'));
  return { root, npmCli, lib: join(v, 'lib'), bin: join(root, 'bin') };
}

function pinsFor(over: { budgetBytes?: number } = {}): TreePins {
  const pdir = tmp('aom-tpl-policy-');
  ensurePolicyKey(pdir);
  return new TreePins(pdir, () => {}, { racyMs: 0, memoryCache: true, ...over });
}

const g = (root: string, legacy: string[] = []): GuardRoots => ({ whole: [root], legacy });

describe('the whole-folder pin (AC1)', () => {
  it('an unchanged folder is accepted; editing npm-cli.js refuses the tool', () => {
    const n = nodeRoot();
    const pins = pinsFor();
    expect(pins.ok(n.bin, g(n.root))).toBe(false); // no pin yet
    pins.clearMemo();
    expect(pins.pin([n.root])).toEqual([n.root]);
    expect(pins.ok(n.bin, g(n.root))).toBe(true);
    writeFileSync(n.npmCli, '#!/usr/bin/env node\nrequire("child_process").exec("evil")\n');
    pins.clearMemo();
    expect(pins.ok(n.bin, g(n.root))).toBe(false);
    expect(pins.status(n.root).state).toBe('changed');
  });

  it('the same size with the old mtime put back is still a change', () => {
    const n = nodeRoot();
    const pins = pinsFor();
    pins.pin([n.root]);
    const st = statSync(n.npmCli);
    const text = readFileSync(n.npmCli, 'utf8');
    writeFileSync(n.npmCli, text.replace('npm', 'evl'));
    utimesSync(n.npmCli, st.atime, st.mtime);
    pins.clearMemo();
    expect(pins.status(n.root).state).toBe('changed');
  });

  it('a lib folder replaced by a link out of the folder is refused; by a link inside it, it is a change', () => {
    const n = nodeRoot();
    const pins = pinsFor();
    pins.pin([n.root]);
    const elsewhere = tmp('aom-tpl-lib-');
    cpSync(n.lib, elsewhere, { recursive: true });
    rmSync(n.lib, { recursive: true });
    symlinkSync(elsewhere, n.lib);
    pins.clearMemo();
    expect(pins.status(n.root)).toMatchObject({ state: 'failed' });
    expect(pins.ok(n.bin, g(n.root))).toBe(false);
    // inside: hashed as a link, so the folder changed
    rmSync(n.lib);
    const copy = join(n.root, 'lib-copy');
    cpSync(elsewhere, copy, { recursive: true });
    symlinkSync(copy, n.lib);
    pins.clearMemo();
    expect(pins.status(n.root).state).toBe('changed');
  });

  it('a mode change is a change; a fifo is refused', () => {
    const n = nodeRoot();
    const pins = pinsFor();
    pins.pin([n.root]);
    chmodSync(n.npmCli, 0o777);
    pins.clearMemo();
    expect(pins.status(n.root).state).toBe('changed');
    chmodSync(n.npmCli, 0o755);
    execFileSync('mkfifo', [join(n.root, 'pipe')]);
    pins.clearMemo();
    expect(pins.status(n.root)).toMatchObject({ state: 'failed', reason: expect.stringContaining('fifo') });
  });

  it('links: a read-only system path is fine (a uv venv over /usr/bin); /tmp, the home folder and dangling outside are refused', () => {
    const cache = new DigestCache();
    const check = (target: string) => {
      const n = nodeRoot();
      symlinkSync(target, join(n.root, 'bin', 'python3'));
      return rootTreeHash(n.root, { cache, racyMs: 0 }).kind;
    };
    expect(check('/bin/sh')).toBe('ok');
    const planted = join(tmp('aom-tpl-planted-'), 'python3');
    writeFileSync(planted, 'x');
    expect(check(planted)).toBe('fail');
    const homeFile = join(homedir(), '.bashrc');
    expect(check(homeFile)).toBe('fail');
    expect(check('/tmp/aom-tpl-does-not-exist-yet')).toBe('fail');
    // dangling inside the folder: fine (creating it changes the hash)
    expect(check('../node/missing')).toBe('ok');
  });

  it('a link in the middle of a target path is followed: through a trusted folder into /tmp is refused', () => {
    const n = nodeRoot();
    const evil = tmp('aom-tpl-evil-');
    writeFileSync(join(evil, 'x'), 'x');
    symlinkSync('/', join(n.root, 'up'));
    // lexically inside the folder (`<root>/up/...`), but the kernel goes / -> tmp -> ...
    symlinkSync(join('..', 'up', evil.slice(1), 'x'), join(n.root, 'bin', 'trick'));
    expect(rootTreeHash(n.root, { cache: new DigestCache(), racyMs: 0 })).toMatchObject({ kind: 'fail' });
  });

  it('two folders with the same content get different hashes (the path is mixed in)', () => {
    const mk = () => {
      const r = join(realpathSync(tmp('aom-tpl-same-')), 'toolchains');
      mkdirSync(join(r, 'bin'), { recursive: true });
      writeFileSync(join(r, 'bin', 'tool'), 'same', { mode: 0o755 });
      symlinkSync('tool', join(r, 'bin', 'alias'));
      return r;
    };
    const a = mk();
    const b = mk();
    const cache = new DigestCache();
    const ha = rootTreeHash(a, { cache, racyMs: 0 });
    const hb = rootTreeHash(b, { cache, racyMs: 0 });
    expect(ha.kind).toBe('ok');
    expect(hb.kind).toBe('ok');
    expect(ha).not.toEqual(hb);
  });

  it('over the read budget the folder is pending (no trust step), and fine after warm()', async () => {
    const n = nodeRoot();
    writeFileSync(join(n.root, 'big.bin'), Buffer.alloc(64 * 1024, 1));
    const seed = pinsFor();
    seed.pin([n.root]);
    const pins = new TreePins(seed.policyDir, () => {}, { racyMs: 0, memoryCache: true, budgetBytes: 1024 });
    const seen: string[] = [];
    pins.onStatus = (_r, s) => seen.push(s.state);
    expect(pins.status(n.root).state).toBe('pending');
    expect(pins.ok(n.bin, g(n.root))).toBe(false);
    await pins.warm(n.root);
    pins.clearMemo();
    expect(pins.status(n.root).state).toBe('ok');
    expect(seen).toEqual(['pending', 'ok']);
  });

  it('pin with an expected hash pins only a folder that still matches it', () => {
    const n = nodeRoot();
    const pins = pinsFor();
    expect(pins.pin([n.root], [], { [n.root]: 'f'.repeat(64) })).toEqual([]);
    const h = pins.fullHash(n.root);
    expect(h.kind).toBe('ok');
    expect(pins.pin([n.root], [], { [n.root]: (h as { hash: string }).hash })).toEqual([n.root]);
    expect(pins.manifestOf(n.root)?.entries['bin/npm']).toMatch(/^l /);
  });

  it('a v1 pin file keeps the bin pins of the user folders and asks for the Guildwise folder once (Decision 1)', () => {
    const n = nodeRoot();
    const legacy = realpathSync(tmp('aom-tpl-cargo-'));
    const lbin = join(legacy, 'bin');
    mkdirSync(lbin);
    writeFileSync(join(lbin, 'cargo'), 'x', { mode: 0o755 });
    const pins = pinsFor();
    const seed = new TreePins(pins.policyDir);
    seed.pin([], [lbin, n.bin]);
    // rewrite it the v1 way: `{ pins }`
    const v2 = JSON.parse(readFileSync(join(pins.policyDir, TREE_PINS_FILE), 'utf8')) as {
      bins: Record<string, string>;
    };
    const key = readFileSync(join(pins.policyDir, 'policy.key'));
    writeFileSync(join(pins.policyDir, TREE_PINS_FILE), JSON.stringify(seal(key, { pins: v2.bins })));
    expect(pins.read().version).toBe(1);
    pins.upgradeV1(g(n.root, [legacy]));
    const f = pins.read();
    expect(f.version).toBe(2);
    expect(Object.keys(f.bins)).toEqual([lbin]);
    pins.clearMemo();
    expect(pins.status(n.root).state).toBe('unpinned');
    expect(pins.ok(lbin, g(n.root, [legacy]))).toBe(true);
  });
});

describe('S1: the user tool folders stay guarded by their bin pins', () => {
  function legacyCargo() {
    const home = realpathSync(tmp('aom-tpl-home-'));
    const cargoBin = join(home, '.cargo', 'bin');
    mkdirSync(cargoBin, { recursive: true });
    writeFileSync(join(cargoBin, 'npm'), '#!/bin/sh\n', { mode: 0o755 });
    const n = nodeRoot();
    const roots = g(n.root, [join(home, '.cargo')]);
    const pins = pinsFor();
    pins.pin([n.root], [cargoBin]);
    return { cargoBin, roots, pins };
  }

  it('a changed ~/.cargo/bin entry is refused on the PATH and by the install gate, with a trust code', () => {
    const { cargoBin, roots, pins } = legacyCargo();
    expect(pins.ok(cargoBin, roots)).toBe(true);
    writeFileSync(join(cargoBin, 'npm'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
    expect(pins.ok(cargoBin, roots)).toBe(false);
    expect(pins.changedBin(cargoBin)).toMatch(/^[0-9a-f]{64}$/);
    // the registry (agents' PATH)
    const reg = new ToolchainRegistry(join(tmp(), 'toolchains.json'), tmp(), undefined, tmp(), 'linux', {
      env: {},
      systemRoots: [],
    });
    reg.add({ name: 'cargo', bin: [cargoBin], read: [], env: {} }, 'owner');
    reg.treeOk = (d) => pins.ok(d, roots);
    expect(reg.resolve().pathDirs).not.toContain(cargoBin);
    // the install gate (`aom devops install`)
    const gate: ToolGate = { waiting: [], treeOk: (d) => pins.ok(d, roots), guardedRootOf: () => null };
    expect(
      findPackageManager('npm', {
        toolchainDirs: [cargoBin],
        realHome: tmp(),
        path: '/nonexistent',
        gate: () => gate,
      }),
    ).toMatchObject({ refusal: expect.any(String) });
    // the owner's yes for exactly this content puts it back
    const code = pins.changedBin(cargoBin) as string;
    expect(pins.pinBin(cargoBin, 'f'.repeat(64))).toBe(false);
    expect(pins.pinBin(cargoBin, code)).toBe(true);
    expect(pins.ok(cargoBin, roots)).toBe(true);
    expect(code).toBe(
      binTrustCode(cargoBin, (pins.read().bins as Record<string, string>)[cargoBin] as string),
    );
  });
});

describe('the entry rule in resolve() (B4)', () => {
  it('an entry whose variable points into a failing Guildwise folder is dropped whole', () => {
    const n = nodeRoot();
    const pins = pinsFor();
    pins.pin([n.root]);
    const other = realpathSync(tmp('aom-tpl-other-'));
    mkdirSync(join(other, 'bin'));
    writeFileSync(join(other, 'bin', 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    const reg = new ToolchainRegistry(join(tmp(), 'toolchains.json'), tmp(), undefined, tmp(), 'linux', {
      env: {},
      systemRoots: [],
    });
    reg.add(
      { name: 'mixed', bin: [join(other, 'bin')], read: [], env: { JAVA_HOME: join(n.root, 'node') } },
      'owner',
    );
    reg.treeOk = (d) => pins.ok(d, g(n.root));
    reg.pathOk = (p) => pins.pathOk(p, g(n.root));
    expect(reg.resolve().pathDirs).toContain(join(other, 'bin'));
    writeFileSync(n.npmCli, 'changed');
    pins.clearMemo();
    const r = reg.resolve();
    expect(r.pathDirs).not.toContain(join(other, 'bin'));
    expect(r.entries.map((e) => e.name)).not.toContain('mixed');
    expect(r.env.JAVA_HOME).toBeUndefined();
    expect(r.dropped).toEqual(['mixed']);
  });
});

describe('the edited toolchain npm is refused by `aom devops install` (AC2)', () => {
  it('rule 3: the real path of a link in a pinned Guildwise folder is checked with the whole folder', () => {
    const n = nodeRoot();
    const pins = pinsFor();
    pins.pin([n.root]);
    const gate: ToolGate = { waiting: [], treeOk: (d) => pins.ok(d, g(n.root)), guardedRootOf: () => null };
    const find = () =>
      findPackageManager('npm', {
        toolchainDirs: [n.bin],
        realHome: tmp(),
        path: '/nonexistent',
        gate: () => gate,
      });
    expect(find()).toMatchObject({ toolPath: join(n.bin, 'npm'), real: realpathSync(n.npmCli) });
    writeFileSync(n.npmCli, 'changed');
    pins.clearMemo();
    expect(find()).toMatchObject({ refusal: expect.any(String) });
  });
});

describe('the box plans', () => {
  const binds = (args: string[]) => {
    const out: Array<[string, string]> = [];
    for (let i = 0; i < args.length; i++)
      if (args[i] === '--bind' || args[i] === '--ro-bind')
        out.push([args[i] as string, args[i + 1] as string]);
    return out;
  };

  it('deps box: every root read-only, the clone writable, a home of its own; recipe box: no clone', () => {
    const base = realpathSync(tmp('aom-tpl-plan-'));
    const tc = join(base, 'tc');
    const cargo = join(base, 'cargo');
    const repo = join(base, 'repo');
    const home = join(base, 'home');
    for (const d of [tc, cargo, repo, home]) mkdirSync(d);
    const deps = binds(toolBoxArgs(depsBoxPlan([tc, cargo], repo, home), repo));
    expect(deps).toContainEqual(['--ro-bind', tc]);
    expect(deps).toContainEqual(['--ro-bind', cargo]);
    expect(deps).toContainEqual(['--bind', repo]);
    expect(deps).toContainEqual(['--bind', home]);
    const recipe = binds(toolBoxArgs(recipeBoxPlan([tc, cargo], tc, home), undefined));
    expect(recipe).toContainEqual(['--bind', tc]);
    expect(recipe).toContainEqual(['--ro-bind', cargo]);
    expect(recipe.map((b) => b[1])).not.toContain(repo);
    // a failing root is not in `before`, so it is not mounted at all
    expect(binds(toolBoxArgs(recipeBoxPlan([cargo], tc, home), undefined)).map((b) => b[1])).not.toContain(
      tc,
    );
  });

  it('a root under a clone stays read-only (one sorted list); a clone under a root is refused', () => {
    const base = realpathSync(tmp('aom-tpl-plan2-'));
    const repo = join(base, 'repo');
    const tc = join(repo, 'vendor', 'tc');
    const home = join(base, 'home');
    mkdirSync(tc, { recursive: true });
    mkdirSync(home);
    const b = binds(toolBoxArgs(depsBoxPlan([tc], repo, home), repo));
    expect(b.findIndex((x) => x[1] === tc)).toBeGreaterThan(b.findIndex((x) => x[1] === repo));
    expect(b).toContainEqual(['--ro-bind', tc]);
    const inner = join(base, 'tc2', 'clone');
    mkdirSync(inner, { recursive: true });
    expect(() => depsBoxPlan([join(base, 'tc2')], inner, home)).toThrow(/inside the tool folder/);
  });
});

describe('renames inside the folder are seen', () => {
  it('moving a file is a change', () => {
    const n = nodeRoot();
    const pins = pinsFor();
    pins.pin([n.root]);
    renameSync(join(n.root, 'node', '22.1.0', 'bin', 'node'), join(n.root, 'node', '22.1.0', 'bin', 'node2'));
    pins.clearMemo();
    expect(pins.status(n.root).state).toBe('changed');
  });
});

// ------------------------------------------------------------------------------------- ensure and the installer

type Call = { cmd: string; args: string[]; opts?: ExecOptions; via: string };
function recorder(via: string, calls: Call[], answer: (c: Call) => ExecResult = () => okR()): Executor {
  return {
    async run(cmd, args, opts) {
      const c: Call = { cmd, args, via, ...(opts ? { opts } : {}) };
      calls.push(c);
      return answer(c);
    },
  };
}
const okR = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
const missing = (): ExecResult => ({ exitCode: 127, stdout: '', stderr: 'not found' });

function ensureWorld(files: Record<string, string>) {
  const repoDir = realpathSync(tmp('aom-tpl-repo-'));
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(repoDir, rel), text);
  const calls: Call[] = [];
  const payload: EnvEnsurePayload = {
    requestId: '0190aaaa-0000-7000-8000-00000000ffff',
    projectId: '0190aaaa-0000-7000-8000-000000000001',
    repos: [
      {
        repoId: '0190aaaa-0000-7000-8000-0000000000a1',
        name: 'app',
        remoteUrlNormalized: 'github.com/acme/app',
      },
    ],
    access: { allowInstall: true, allowDocker: false, allowedPaths: [], sudo: false },
  };
  const base: EnsureDeps = {
    exec: recorder('recipe', calls, (c) =>
      c.cmd === 'cargo' && c.args[0] === '--version'
        ? okR('cargo 1.80.0')
        : c.cmd === 'rustup'
          ? okR()
          : missing(),
    ),
    platform: 'linux',
    findRepo: async () => ({ localPath: repoDir }),
    installScriptsAllowed: () => true,
    toolchainsRoot: join(repoDir, '..', 'tc'),
  };
  return { repoDir, calls, payload, base };
}

describe('env.ensure in the boxes (B1)', () => {
  it('a Guildwise tool folder that did not verify: no check, recipe or user install runs; each tool says so', async () => {
    const w = ensureWorld({ 'go.mod': 'module x\n\ngo 1.22\n' });
    let installs = 0;
    const r = await ensureEnvironment(w.payload, {
      ...w.base,
      allowInstalls: false,
      userInstaller: {
        install: async () => {
          installs++;
          return { ok: true, detail: '' };
        },
      },
    });
    expect(r.tools.find((t) => t.tool === 'Go')).toMatchObject({
      status: 'failed',
      detail: TOOL_FOLDER_CHANGED,
    });
    expect(installs).toBe(0);
    expect(w.calls.filter((c) => c.cmd === 'go')).toEqual([]);
  });

  it('dependency steps run through the deps box executor; the rust toolchain file is installed in the recipe box first', async () => {
    const w = ensureWorld({
      'Cargo.toml': '[package]\nname="x"\n',
      'rust-toolchain.toml':
        '[toolchain]\nchannel = "1.79.0"\ncomponents = ["clippy", "rustfmt"]\ntargets = ["wasm32-unknown-unknown"]\n',
    });
    const r = await ensureEnvironment(w.payload, {
      ...w.base,
      depsExec: (remote, localPath) => {
        expect(remote).toBe('github.com/acme/app');
        expect(localPath).toBe(w.repoDir);
        return recorder('deps', w.calls);
      },
    });
    const rustup = w.calls.find((c) => c.cmd === 'rustup');
    expect(rustup).toMatchObject({
      via: 'recipe',
      args: [
        'toolchain',
        'install',
        '1.79.0',
        '--profile',
        'minimal',
        '-c',
        'clippy',
        '-c',
        'rustfmt',
        '-t',
        'wasm32-unknown-unknown',
      ],
    });
    const fetch = w.calls.find((c) => c.cmd === 'cargo' && c.args[0] === 'fetch');
    expect(fetch?.via).toBe('deps');
    expect(w.calls.indexOf(rustup as Call)).toBeLessThan(w.calls.indexOf(fetch as Call));
    expect(r.tools.find((t) => t.tool === 'cargo fetch')?.status).toBe('installed');
  });

  it('S6: while an approved outside run is active, no user-space install runs', async () => {
    const w = ensureWorld({ 'go.mod': 'module x\n\ngo 1.22\n' });
    let installs = 0;
    const r = await ensureEnvironment(w.payload, {
      ...w.base,
      userInstallBlocked: () => 'an approved DevOps run outside the safety box is active',
      userInstaller: {
        install: async () => {
          installs++;
          return { ok: true, detail: '' };
        },
      },
    });
    expect(installs).toBe(0);
    expect(r.tools.find((t) => t.tool === 'Go')?.detail).toContain('outside the safety box is active');
  });
});

describe('the rust toolchain file (S8, S4)', () => {
  const req = (files: Record<string, string>) => {
    const d = tmp('aom-tpl-rt-');
    for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
    return rustToolchainRequest(d);
  };
  it('channels, components and targets are validated; the legacy bare file works; anything else is refused', () => {
    expect(req({})).toBeNull();
    expect(req({ 'rust-toolchain': 'nightly-2024-05-01\n' })).toEqual({
      channel: 'nightly-2024-05-01',
      components: [],
      targets: [],
    });
    expect(req({ 'rust-toolchain.toml': '[toolchain]\nchannel = "stable"\n' })).toMatchObject({
      channel: 'stable',
    });
    expect(req({ 'rust-toolchain': 'my-custom' })).toHaveProperty('refused');
    expect(req({ 'rust-toolchain.toml': '[toolchain]\npath = "/opt/rust"\n' })).toHaveProperty('refused');
    expect(req({ 'rust-toolchain.toml': '[toolchain]\nchannel = "stable; rm -rf"\n' })).toHaveProperty(
      'refused',
    );
    expect(
      req({ 'rust-toolchain.toml': '[toolchain]\nchannel = "stable"\ncomponents = ["clippy --x"]\n' }),
    ).toHaveProperty('refused');
  });
});

describe('the user installer (B1, S3)', () => {
  it('runs with exactly its environment: PATH of the verified folders plus /usr/bin:/bin, the account HOME', async () => {
    const calls: Call[] = [];
    const ex = installerExecutor(recorder('i', calls), ['/x/tc/bin'], '/home/acc');
    await ex.run('/x/tc/bin/uv', ['python', 'install'], {
      env: { UV_TOOL_DIR: '/x/tc/uv-tools', PATH: '/evil' },
    });
    expect(calls[0]?.opts).toMatchObject({
      exactEnv: true,
      env: {
        HOME: '/home/acc',
        LANG: 'C.UTF-8',
        PATH: '/x/tc/bin:/usr/bin:/bin',
        UV_TOOL_DIR: '/x/tc/uv-tools',
      },
    });
  });

  it('stepAllowed: a path in a guarded folder that did not verify is refused, in the command or an argument', () => {
    const guard = { roots: ['/h/tc', '/h/.cargo'], before: ['/h/.cargo'] };
    expect(stepRefusal({ cmd: '/h/tc/bin/uv', args: [] }, guard)).toMatch(/refused/);
    expect(stepRefusal({ cmd: '/usr/bin/env', args: ['--sdk_root=/h/tc/android-sdk'] }, guard)).toMatch(
      /refused/,
    );
    expect(stepRefusal({ cmd: '/h/.cargo/bin/x', args: ['/tmp/a'] }, guard)).toBeNull();
    expect(stepRefusal({ cmd: '/h/tc/bin/uv', args: [] }, { ...guard, before: ['/h/tc'] })).toBeNull();
  });

  it('uv writes the bytecode at install time (S5)', () => {
    expect(uvEnv('/r').UV_COMPILE_BYTECODE).toBe('1');
  });
});

// ------------------------------------------------------------------------------------------------- the lock

describe('one env.ensure at a time (B3) and the updater (S6)', () => {
  it('runs one after the other; a queued one is told; the updater waits for a running one and then holds the lock', async () => {
    resetEnsureLockForTests();
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let waited = 0;
    const a = withEnsureLock(async () => {
      setRunning(['/tc']);
      order.push('a-start');
      await gateA;
      order.push('a-end');
    });
    const b = withEnsureLock(
      async () => {
        order.push('b');
      },
      () => waited++,
    );
    await new Promise((r) => setImmediate(r));
    expect(runningBefore()?.has('/tc')).toBe(true);
    expect(ensureBusy()).toBe(true);
    const hold = holdForRestart(5_000);
    releaseA();
    await Promise.all([a, b]);
    const h = await hold;
    expect(h.held).toBe(true);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    expect(waited).toBe(1);
    // the updater holds it: a new ensure waits until it lets go (a restart that did not happen)
    let c = false;
    const pc = withEnsureLock(async () => {
      c = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(c).toBe(false);
    h.release();
    await pc;
    expect(c).toBe(true);
  });

  it('the updater gives up waiting after its bound', async () => {
    resetEnsureLockForTests();
    let release!: () => void;
    const p = withEnsureLock(() => new Promise<void>((r) => (release = r)));
    const h = await holdForRestart(30);
    expect(h.held).toBe(false);
    release();
    await p;
  });

  it('counts approved outside runs with an epoch', () => {
    resetEnsureLockForTests();
    noteOutside(1);
    noteOutside(-1);
    expect(outsideState()).toEqual({ active: 0, epoch: 1 });
  });
});

// --------------------------------------------------------------------------------------------- the trust CLI

describe('guildwise-runner toolchain trust', () => {
  function cli(pins: TreePins, root: string, answer = 'yes') {
    const out: string[] = [];
    const logs = tmp('aom-tpl-logs-');
    return {
      out,
      logs,
      deps: {
        store: { dir: pins.policyDir },
        out: (l: string) => out.push(l),
        ask: async () => answer,
        treePins: () => pins,
        guardRoots: () => g(root),
        logsDir: () => logs,
      } as unknown as PolicyCliDeps,
    };
  }

  it('shows changed links and programs first, writes the full list, and pins exactly the content shown', async () => {
    const n = nodeRoot();
    const pins = pinsFor();
    pins.pin([n.root]);
    writeFileSync(n.npmCli, 'changed');
    writeFileSync(join(n.root, 'node', 'README'), 'doc');
    pins.clearMemo();
    const st = pins.status(n.root);
    expect(st.state).toBe('changed');
    const c = cli(pins, n.root);
    await toolchainTrust(c.deps, st.hash as string);
    const text = c.out.join('\n');
    expect(text.indexOf('npm-cli.js')).toBeGreaterThan(-1);
    expect(text).toContain('In all: 1 added, 1 changed, 0 removed.');
    expect(text.indexOf('npm-cli.js')).toBeLessThan(text.indexOf('In all'));
    expect(text.slice(text.indexOf('Links and programs'), text.indexOf('In all'))).not.toContain('README');
    pins.clearMemo();
    expect(pins.status(n.root).state).toBe('ok');
  });

  it('a stale code (the folder changed again) is refused and nothing is pinned', async () => {
    const n = nodeRoot();
    const pins = pinsFor();
    pins.pin([n.root]);
    writeFileSync(n.npmCli, 'changed');
    pins.clearMemo();
    const code = pins.status(n.root).hash as string;
    writeFileSync(n.npmCli, 'changed again');
    await expect(toolchainTrust(cli(pins, n.root).deps, code)).rejects.toThrow(
      /no tool folder has exactly this content/,
    );
    pins.clearMemo();
    expect(pins.status(n.root).state).toBe('changed');
  });

  it('a folder with a link out of it cannot be allowed', async () => {
    const n = nodeRoot();
    const pins = pinsFor();
    const outside = join(tmp('aom-tpl-out-'), 'x');
    writeFileSync(outside, 'x');
    symlinkSync(outside, join(n.root, 'bin', 'x'));
    const st = pins.status(n.root);
    expect(st.state).toBe('failed');
    await expect(
      toolchainTrust(cli(pins, n.root).deps, refusedCode(n.root, st.reason as string)),
    ).rejects.toThrow(/cannot be allowed as it is/);
  });
});

describe('an extra the owner installs at the terminal', () => {
  it('re-pins a folder that verified before, never one that had changed', async () => {
    const n = nodeRoot();
    const pins = pinsFor();
    pins.pin([n.root]);
    const install = async () => {
      writeFileSync(join(n.root, 'bin', 'yt-dlp'), 'x', { mode: 0o755 });
      return { ok: true };
    };
    await keepingToolPin(pins.policyDir, install, n.root);
    pins.clearMemo();
    expect(pins.status(n.root).state).toBe('ok');
    writeFileSync(n.npmCli, 'planted');
    await keepingToolPin(pins.policyDir, install, n.root);
    pins.clearMemo();
    expect(pins.status(n.root).state).toBe('changed');
  });
});

// ------------------------------------------------------------------------------------------------ rework 1

describe('pre-review 1: a changed user tool folder is left out of the run', () => {
  it('not verified, so not on the installer PATH and a step naming it is refused', async () => {
    const legacy = realpathSync(tmp('aom-tpl-cargo2-'));
    const lbin = join(legacy, 'bin');
    mkdirSync(lbin);
    writeFileSync(join(lbin, 'cargo'), 'x', { mode: 0o755 });
    const pins = pinsFor();
    pins.pin([], [lbin]);
    const unpinned = realpathSync(tmp('aom-tpl-bun-'));
    expect(pins.legacyRootOk(legacy)).toBe(true);
    expect(pins.legacyRootOk(unpinned)).toBe(true);
    writeFileSync(join(lbin, 'cargo'), 'planted', { mode: 0o755 });
    expect(pins.legacyRootOk(legacy)).toBe(false);
    const before = [legacy, unpinned].filter((r) => pins.legacyRootOk(r));
    const calls: Call[] = [];
    await installerExecutor(
      recorder('i', calls),
      before.map((r) => join(r, 'bin')),
      '/home/acc',
    ).run('/x', []);
    expect(calls[0]?.opts?.env?.PATH).not.toContain(legacy);
    expect(
      stepRefusal({ cmd: join(lbin, 'cargo'), args: [] }, { roots: [legacy, unpinned], before }),
    ).toMatch(/refused/);
  });
});

describe('pre-review 3: stepAllowed checks the step variables too', () => {
  it('a variable pointing into a tool folder that did not verify is refused', () => {
    const guard = { roots: ['/h/tc'], before: [] as string[] };
    expect(
      stepRefusal({ cmd: '/usr/bin/true', args: [], env: { UV_TOOL_DIR: '/h/tc/uv-tools' } }, guard),
    ).toMatch(/refused/);
    expect(stepRefusal({ cmd: '/usr/bin/true', args: [], env: { LANG: 'C' } }, guard)).toBeNull();
  });
});

describe('pre-review 2: agents prefer the Guildwise .NET root (Decision 3)', () => {
  const sdk = (root: string, ...vs: string[]) => {
    for (const v of vs) mkdirSync(join(root, 'sdk', v), { recursive: true });
  };
  it('its own root with an SDK wins over ~/.dotnet with more SDKs; a configured root wins over both', () => {
    const home = realpathSync(tmp('aom-tpl-dnhome-'));
    sdk(join(home, '.dotnet'), '8.0.100', '10.0.100');
    const own = join(home, '.local', 'share', 'guildwise', 'toolchains', 'dotnet');
    expect(selectDotnet({ home, env: {}, systemRoots: [] }).chosen?.root).toBe(join(home, '.dotnet'));
    sdk(own, '9.0.100');
    expect(selectDotnet({ home, env: {}, systemRoots: [] })).toMatchObject({
      chosen: { root: own },
      reason: 'guildwise',
    });
    expect(selectDotnet({ home, env: {}, systemRoots: [], override: join(home, '.dotnet') })).toMatchObject({
      chosen: { root: join(home, '.dotnet') },
      reason: 'config',
    });
  });
});

const bwrapOk =
  process.platform === 'linux' && execFileSyncOk('bwrap', ['--unshare-user', '--dev-bind', '/', '/', 'true']);
function execFileSyncOk(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!bwrapOk)('pre-review 4: a mount inside the folder is refused (the st_dev rule)', () => {
  it('a tmpfs mounted on a folder inside the root fails the check; without it the root is fine', () => {
    const n = nodeRoot();
    const sub = join(n.root, 'mounted');
    mkdirSync(sub);
    const script = join(realpathSync(tmp('aom-tpl-dev-')), 'check.ts');
    writeFileSync(
      script,
      `import { DigestCache, rootTreeHash } from ${JSON.stringify(join(process.cwd(), 'src', 'box', 'tree-hash.ts'))};\nconsole.log(JSON.stringify(rootTreeHash(${JSON.stringify(n.root)}, { cache: new DigestCache(), racyMs: 0 })));\n`,
    );
    const tsx = join(process.cwd(), '..', '..', 'node_modules', '.bin', 'tsx');
    const run = (extra: string[]) =>
      JSON.parse(
        execFileSync('bwrap', ['--unshare-user', '--dev-bind', '/', '/', ...extra, tsx, script], {
          encoding: 'utf8',
        })
          .trim()
          .split('\n')
          .at(-1) as string,
      ) as { kind: string; reason?: string };
    expect(run([]).kind).toBe('ok');
    expect(run(['--tmpfs', sub])).toMatchObject({
      kind: 'fail',
      reason: expect.stringContaining('another filesystem'),
    });
  }, 60_000);
});

// ------------------------------------------------------------------------------------------------ rework 2

describe('review B1: the rust toolchain file of a repository is read safely', () => {
  it('a link to a secret is refused and nothing of the file reaches the report', async () => {
    const secret = join(realpathSync(tmp('aom-tpl-secret-')), 'creds');
    writeFileSync(secret, 'https://user:tok3n-SECRET@host\n');
    const w = ensureWorld({ 'Cargo.toml': '[package]\nname="x"\n' });
    symlinkSync(secret, join(w.repoDir, 'rust-toolchain'));
    expect(rustToolchainRequest(w.repoDir)).toEqual({ refused: expect.stringContaining('not a plain file') });
    const r = await ensureEnvironment(w.payload, w.base);
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(r.tools.find((t) => t.tool === 'cargo fetch')?.status).toBe('failed');
  });

  it('a plain file that is no channel is refused without echoing it', () => {
    const d = tmp('aom-tpl-rt2-');
    writeFileSync(join(d, 'rust-toolchain'), 'tok3n-SECRET');
    const r = rustToolchainRequest(d);
    expect(r).toHaveProperty('refused');
    expect(JSON.stringify(r)).not.toContain('SECRET');
    writeFileSync(join(d, 'rust-toolchain.toml'), '[toolchain]\nchannel = "tok3n-SECRET"\n');
    expect(JSON.stringify(rustToolchainRequest(d))).not.toContain('SECRET');
  });

  it('a FIFO (or a link to one, or to /dev/zero) returns at once instead of blocking the runner', () => {
    const d = realpathSync(tmp('aom-tpl-fifo-'));
    const cases: Array<[string, () => void]> = [
      ['fifo', () => execFileSync('mkfifo', [join(d, 'fifo', 'rust-toolchain')])],
      [
        'link-fifo',
        () => {
          execFileSync('mkfifo', [join(d, 'link-fifo', 'p')]);
          symlinkSync(join(d, 'link-fifo', 'p'), join(d, 'link-fifo', 'rust-toolchain'));
        },
      ],
      ['zero', () => symlinkSync('/dev/zero', join(d, 'zero', 'rust-toolchain'))],
    ];
    const script = join(realpathSync(tmp('aom-tpl-fifo-s-')), 'read.mts');
    const tsx = join(process.cwd(), '..', '..', 'node_modules', '.bin', 'tsx');
    for (const [name, make] of cases) {
      mkdirSync(join(d, name));
      make();
      writeFileSync(
        script,
        `import { rustToolchainRequest } from ${JSON.stringify(join(process.cwd(), 'src', 'toolchain', 'ensure.ts'))};\nconsole.log(JSON.stringify(rustToolchainRequest(${JSON.stringify(join(d, name))})));\n`,
      );
      const out = execFileSync(tsx, [script], { encoding: 'utf8', timeout: 20_000 });
      expect(JSON.parse(out.trim().split('\n').at(-1) as string), name).toHaveProperty('refused');
    }
  }, 90_000);
});

describe('review B2: a link may not end at a folder above the tool folder', () => {
  it('<root>/x -> the folder holding the tool folder fails; -> / stays ok', () => {
    const check = (target: (root: string) => string) => {
      const n = nodeRoot();
      symlinkSync(target(n.root), join(n.root, 'x'));
      return rootTreeHash(n.root, { cache: new DigestCache(), racyMs: 0 });
    };
    expect(check((r) => dirname(r))).toMatchObject({
      kind: 'fail',
      reason: expect.stringContaining('above the tool folder'),
    });
    expect(check((r) => dirname(dirname(r)))).toMatchObject({ kind: 'fail' });
    expect(check(() => '/').kind).toBe('ok');
    // passing an ancestor on the way back in is still fine
    expect(check((r) => join(dirname(r), basename(r), 'bin')).kind).toBe('ok');
  });
});

describe('review S2: the outside-run check is asked after the asynchronous warm, right before the pin', () => {
  it('no overlap at that moment pins; an overlap found then keeps the old pin', async () => {
    const n = nodeRoot();
    const pins = pinsFor();
    pins.pin([n.root]);
    const old = pins.read().roots[n.root] as string;
    writeFileSync(n.npmCli, 'installed by the run');
    const order: string[] = [];
    const warm = pins.warm.bind(pins);
    pins.warm = (r: string) => {
      order.push('warm');
      return warm(r);
    };
    // an outside run starts during the warm: found when the check is asked
    expect(
      await pins.pinAsync([n.root], () => {
        order.push('check');
        return { [n.root]: old };
      }),
    ).toEqual([]);
    expect(order).toEqual(['warm', 'check']);
    // no overlap: the run's own install is pinned
    expect(await pins.pinAsync([n.root], () => undefined)).toEqual([n.root]);
  });
});

describe('review S3: uv keeps no cache in the pinned folder', () => {
  it('UV_NO_CACHE is set for uv installs', () => {
    expect(uvEnv('/r').UV_NO_CACHE).toBe('1');
  });
});
