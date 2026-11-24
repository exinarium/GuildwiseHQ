import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, localCommandOk } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDevopsChatSettings, buildShiftSettings } from '../src/adapters/claude-policy.ts';
import { classifyCommand, defaultGuardConfig, type GuardConfig } from '../src/devops/guard.ts';
import { CEO_TURN_FILE, FileAuthority, openOwnerTurn } from '../src/policy/authority.ts';
import { policyAccept, toolchainApprove } from '../src/policy/cli.ts';
import { HeldStore } from '../src/policy/held.ts';
import { ensurePolicyKey, POLICY_KEY_FILE, sealMarkerFor } from '../src/policy/integrity.ts';
import { PasskeyStore } from '../src/policy/passkey-store.ts';
import { DEFAULT_POLICY } from '../src/policy/schema.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { readPolicy, writePolicy } from '../src/setup/policy-file.ts';
import { ToolchainRegistry, toolchainHash, toolchainRpc } from '../src/toolchain/registry.ts';
import { DeviceStore } from '../src/window/pairing.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

/**
 * runner-authority-fixes T2 (AC3, AC4): the local authority files are sealed with a runner-held key; a file changed
 * outside the runner never grants (everything asks); DevOps tools and its shell cannot reach the policy folder; a
 * toolchain the DevOps engineer registers waits for the owner's yes before other agents get it.
 */

cleanupTmp();
const saved = { token: process.env.AOM_SHIFT_TOKEN, id: process.env.AOM_SHIFT_ID };
afterEach(() => {
  for (const [k, v] of [
    ['AOM_SHIFT_TOKEN', saved.token],
    ['AOM_SHIFT_ID', saved.id],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A bin folder with one executable (a toolchain must hold one). */
function makeBin(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
}

/** The runner's first start made the key (Rework 1: only the runner's adoption creates it). */
const runnerStarted = (dir: string) => ensurePolicyKey(dir);
const granted = (s: PolicyStore) => {
  runnerStarted(s.dir);
  return s.update((p) => ({ ...p, allowDocker: true, ceo: { fullPower: true }, setupDone: true }));
};

describe('AC3: a policy changed outside the runner is detected at load and everything asks', () => {
  it('a sealed policy reads back; one changed byte gives the safe defaults with a reason', () => {
    const dir = tmp();
    const s = new PolicyStore(dir);
    granted(s);
    expect(existsSync(join(dir, POLICY_KEY_FILE))).toBe(true);
    expect(s.read()).toMatchObject({ error: null, policy: { allowDocker: true } });
    const text = readFileSync(s.file, 'utf8');
    writeFileSync(s.file, text.replace('"allowDocker": true', '"allowDocker": false'));
    const r = new PolicyStore(dir).read();
    expect(r.error).toMatch(/changed outside the runner/);
    expect(r.policy).toEqual(DEFAULT_POLICY);
  });

  it('an agent edit that keeps the old seal but grants more is refused too', () => {
    const dir = tmp();
    const s = new PolicyStore(dir);
    granted(s);
    const obj = JSON.parse(readFileSync(s.file, 'utf8'));
    obj.devops.agents['00000000-0000-4000-8000-000000000001'] = '00000000-0000-4000-8000-000000000002';
    writeFileSync(s.file, JSON.stringify(obj));
    expect(new PolicyStore(dir).read().policy.devops.agents).toEqual({});
  });

  it('a deleted key with a sealed file is tampering, not a fresh start', () => {
    const dir = tmp();
    const s = new PolicyStore(dir);
    granted(s);
    rmSync(join(dir, POLICY_KEY_FILE));
    const r = new PolicyStore(dir).read();
    expect(r.error).toMatch(/key is missing/);
    expect(r.policy.allowDocker).toBe(false);
  });

  it('a policy from before the seal is adopted once (toolchains pinned, marker written); a second adoption is refused', () => {
    const dir = tmp();
    const data = tmp();
    const marker = sealMarkerFor(data);
    writeFileSync(join(dir, 'policy.json'), JSON.stringify({ allowDocker: true, setupDone: true }));
    const s = new PolicyStore(dir, { sealMarker: marker });
    expect(s.read()).toMatchObject({ error: null, adoptable: true, policy: { allowDocker: true } });
    expect(s.adopt(['a'.repeat(64)])).toBe(true);
    expect(existsSync(marker)).toBe(true);
    expect(s.read()).toMatchObject({
      error: null,
      policy: { allowDocker: true, toolchainPins: ['a'.repeat(64)] },
    });
    expect(s.read().adoptable).toBeUndefined();
    expect(s.adopt()).toBe(false);
    // somebody removes the key, the seal and the pins: the marker says this machine was sealed before
    rmSync(join(dir, POLICY_KEY_FILE));
    writeFileSync(join(dir, 'policy.json'), JSON.stringify({ allowDocker: true, setupDone: true }));
    const again = new PolicyStore(dir, { sealMarker: marker });
    expect(again.read().error).toMatch(/key is missing/);
    expect(again.adopt()).toBe(false);
    expect(again.get().allowDocker).toBe(false);
  });

  it('`policy accept` shows the file and seals it after a typed yes (the way back)', async () => {
    const dir = tmp();
    const s = new PolicyStore(dir);
    granted(s);
    rmSync(join(dir, POLICY_KEY_FILE));
    const out: string[] = [];
    const d = {
      store: s,
      held: new HeldStore(dir),
      passkeys: new PasskeyStore(dir),
      out: (l: string) => out.push(l),
    };
    await expect(policyAccept({ ...d, ask: async () => 'no' })).rejects.toThrow(/not accepted/);
    expect(s.read().error).toMatch(/key is missing/);
    await policyAccept({ ...d, ask: async () => 'yes' });
    expect(out.join('\n')).toContain('"allowDocker": true');
    expect(s.read()).toMatchObject({ error: null, policy: { allowDocker: true } });
  });

  it("the installer's setup writes a sealed policy, and refuses to build on a file changed outside the runner", () => {
    const dir = tmp();
    const file = join(dir, 'policy.json');
    runnerStarted(dir);
    writePolicy(file, { ...DEFAULT_POLICY, setupDone: true, allowDocker: true });
    expect(new PolicyStore(dir).read()).toMatchObject({ error: null, policy: { allowDocker: true } });
    expect(readPolicy(file).allowDocker).toBe(true);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"allowDocker": true', '"allowDocker": false'));
    expect(() => readPolicy(file)).toThrow(/changed outside the runner/);
  });

  it('Rework 1 (S1): setup refuses to re-seal a sealed policy whose key was deleted', () => {
    const dir = tmp();
    const data = tmp();
    const file = join(dir, 'policy.json');
    runnerStarted(dir);
    new PolicyStore(dir, { sealMarker: sealMarkerFor(data) }).update((p) => ({ ...p, allowDocker: true }));
    rmSync(join(dir, POLICY_KEY_FILE));
    expect(() => readPolicy(file, sealMarkerFor(data))).toThrow(/changed outside the runner/);
    // a hand-edited copy without the seal field but with the pins is refused too
    const obj = JSON.parse(readFileSync(file, 'utf8'));
    delete obj.integrity;
    writeFileSync(file, JSON.stringify(obj));
    expect(() => readPolicy(file)).toThrow(/changed outside the runner/);
    expect(existsSync(join(dir, POLICY_KEY_FILE))).toBe(false);
  });

  it('Rework 1 (S1): setup and CLI writes before the first runner start keep the adoption', () => {
    const dir = tmp();
    const data = tmp();
    const marker = sealMarkerFor(data);
    writePolicy(join(dir, 'policy.json'), { ...DEFAULT_POLICY, setupDone: true });
    const store = new PolicyStore(dir, { sealMarker: marker });
    store.update((p) => ({ ...p, allowDocker: true }));
    const now = new Date();
    new HeldStore(dir).put({
      id: 'cccccc1234',
      kind: 'deploy.exec',
      pairing: '/p',
      summary: 'deploy',
      detail: 'deploy',
      commandHash: 'a'.repeat(64),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      replay: { type: 'command', body: {} },
      state: 'held',
    });
    expect(existsSync(join(dir, POLICY_KEY_FILE))).toBe(false);
    expect(store.read()).toMatchObject({ error: null, adoptable: true, policy: { allowDocker: true } });
    expect(new HeldStore(dir).unsealed()).toEqual(['cccccc1234']);
    // the runner's first start adopts it: toolchains pinned, key and marker written
    expect(store.adopt(['b'.repeat(64)])).toBe(true);
    expect(store.read()).toMatchObject({
      error: null,
      policy: { allowDocker: true, toolchainPins: ['b'.repeat(64)] },
    });
    expect(existsSync(marker)).toBe(true);
  });

  it('nothing is written from an agent session (its environment carries the shift token or id)', () => {
    const dir = tmp();
    process.env.AOM_SHIFT_TOKEN = 'x';
    expect(() => granted(new PolicyStore(dir))).toThrow(/agent session/);
    expect(() => openOwnerTurn(dir, 5)).toThrow(/agent session/);
    delete process.env.AOM_SHIFT_TOKEN;
    process.env.AOM_SHIFT_ID = 'y';
    expect(() => new DeviceStore(dir).writeDevices([])).toThrow(/agent session/);
  });

  it('a tampered held record is quarantined: never listed or approvable', () => {
    const dir = tmp();
    runnerStarted(dir);
    const held = new HeldStore(dir);
    const now = new Date();
    const rec = {
      id: 'abcdef1234',
      kind: 'deploy.exec',
      pairing: '/p',
      summary: 'deploy',
      detail: 'deploy',
      commandHash: 'a'.repeat(64),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      replay: { type: 'command', body: {} },
      state: 'held' as const,
    };
    held.put(rec);
    expect(held.get('abcdef1234')?.state).toBe('held');
    const file = join(dir, 'held', 'abcdef1234.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"state":"held"', '"state":"approved"'));
    expect(held.get('abcdef1234')).toBeNull();
    expect(held.list()).toEqual([]);
    expect(existsSync(join(dir, 'held', 'quarantine', 'abcdef1234.json'))).toBe(true);
    // a record planted without a seal is quarantined as well
    writeFileSync(join(dir, 'held', 'bbbbbb1234.json'), JSON.stringify({ ...rec, id: 'bbbbbb1234' }));
    expect(held.list()).toEqual([]);
  });

  it('a planted CEO turn or paired browser does not count; the runner-written ones do', () => {
    const dir = tmp();
    const s = new PolicyStore(dir);
    granted(s);
    const auth = new FileAuthority(s);
    writeFileSync(
      join(dir, CEO_TURN_FILE),
      JSON.stringify({ until: new Date(Date.now() + 600_000).toISOString() }),
    );
    expect(auth.takeOwnerTurn()).toBe(false);
    openOwnerTurn(dir, 5);
    expect(auth.takeOwnerTurn()).toBe(true);

    const dev = {
      keyHash: 'b'.repeat(64),
      spki: 'x',
      fingerprint: 'abcdef12',
      userAgent: 'planted',
      pairedAt: new Date().toISOString(),
    };
    mkdirSync(join(dir, 'window'), { recursive: true });
    writeFileSync(join(dir, 'window', 'devices.json'), JSON.stringify({ devices: [dev] }));
    expect(new DeviceStore(dir).devices()).toEqual([]);
    new DeviceStore(dir).writeDevices([dev]);
    expect(new DeviceStore(dir).devices()).toHaveLength(1);
  });
});

describe('AC3: DevOps tools and its shell cannot modify the policy folder', () => {
  const PDIR = '/home/me/.config/aom-runner';
  const devopsRole = BUILTIN_ROLES.find((r) => r.key === 'devops');

  it('the DevOps shift and chat deny Read, Edit and Write of the policy folder; sandboxed shells cannot see it', () => {
    if (!devopsRole) throw new Error('no devops role');
    const ctx = policyCtx({ policyDir: PDIR });
    for (const s of [
      buildShiftSettings(devopsRole.permissions, ctx, POLICY_PATHS, 'devops', true),
      buildDevopsChatSettings(devopsRole.permissions, ctx, POLICY_PATHS),
    ]) {
      for (const tool of ['Read', 'Edit', 'Write'])
        expect(s.permissions.deny).toEqual(
          expect.arrayContaining([`${tool}(/${PDIR})`, `${tool}(/${PDIR}/**)`]),
        );
    }
    const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
    if (!builder) throw new Error('no builder role');
    expect(
      buildShiftSettings(builder.permissions, ctx, POLICY_PATHS, 'builder').sandbox?.filesystem.denyRead,
    ).toContain(PDIR);
  });

  const cfg: GuardConfig = { ...defaultGuardConfig('shift'), home: '/home/me', policyRoot: PDIR };
  it.each([
    `echo '{}' > ${PDIR}/policy.json`,
    `sed -i s/false/true/ ${PDIR}/policy.json`,
    `cp /tmp/p.json ${PDIR}/policy.json`,
    `cat ${PDIR}/policy.key`,
    'cat ~/.config/aom-runner/held/abc.json',
    `cd ${PDIR} && ls`,
    'guildwise-runner policy accept',
    'guildwise-runner approve abcdef1234',
    'guildwise-runner approvals pair ABCD-1234',
    '/home/me/.local/bin/guildwise-runner devops grant x --agent y',
    'aom-runner toolchain approve aaaa',
  ])('the guard refuses `%s`', (c) => {
    const v = classifyCommand(c, cfg, '/tmp');
    expect(v.decision).toBe('refused');
    expect(v.rule).toBe('policy_fence');
  });

  it.each([
    'guildwise-runner policy',
    'guildwise-runner pending',
    'guildwise-runner status',
    'aom-runner --version',
  ])('the guard allows the read-only `%s`', (c) => {
    expect(classifyCommand(c, cfg, '/tmp').decision).toBe('allowed');
  });

  it('an approval of the exact command does not lift the fence', () => {
    const v = classifyCommand(
      'guildwise-runner approve abcdef1234',
      { ...cfg, approvedCommands: ['guildwise-runner approve abcdef1234'] },
      '/tmp',
    );
    expect(v.decision).toBe('refused');
  });
});

describe('AC4: a toolchain DevOps registers waits for the owner before other agents get it', () => {
  function registry(pins: string[]) {
    const root = tmp();
    const bin = join(tmp(), 'tool', 'bin');
    makeBin(bin);
    const reg = new ToolchainRegistry(
      join(root, 'toolchains.json'),
      root,
      () => ({ toolchainPaths: [] }),
      tmp(),
    );
    reg.pinned = (h) => pins.includes(h);
    return { reg, bin };
  }

  it('an unpinned DevOps entry is off PATH and listed as waiting; once pinned it is on PATH', () => {
    const pins: string[] = [];
    const { reg, bin } = registry(pins);
    const r = toolchainRpc(reg, 'toolchain.add', { name: 'yt-dlp', bin: [bin] }, true);
    expect(r).toMatchObject({
      ok: true,
      result: { message: expect.stringContaining("waits for the owner's yes") },
    });
    expect(reg.resolve().pathDirs).not.toContain(bin);
    expect(reg.resolve().readDirs).not.toContain(bin);
    const waiting = reg.waiting();
    expect(waiting.map((w) => w.entry.name)).toEqual(['yt-dlp']);
    const listed = toolchainRpc(reg, 'toolchain.list', {}, false);
    expect(JSON.stringify(listed)).toContain('waiting for the owner');
    pins.push(waiting[0]?.hash as string);
    expect(reg.resolve().pathDirs).toContain(bin);
    expect(reg.waiting()).toEqual([]);
  });

  it('a changed entry (another folder) needs a new yes', () => {
    const pins: string[] = [];
    const { reg, bin } = registry(pins);
    reg.add({ name: 'x', bin: [bin] }, 'devops');
    pins.push(toolchainHash(reg.persisted()[0] as never));
    const other = join(tmp(), 'other', 'bin');
    makeBin(other);
    reg.add({ name: 'x', bin: [other] }, 'devops');
    expect(reg.resolve().pathDirs).not.toContain(other);
  });

  it('an entry the owner adds needs no pin', () => {
    const { reg, bin } = registry([]);
    reg.add({ name: 'mine', bin: [bin] }, 'owner');
    expect(reg.resolve().pathDirs).toContain(bin);
  });

  it('the local step is a valid copy-paste command; `toolchain approve` shows the entry and pins it after a typed yes', async () => {
    expect(localCommandOk(`guildwise-runner toolchain approve ${'c'.repeat(64)}`)).toBe(true);
    const pdir = tmp();
    const store = new PolicyStore(pdir);
    runnerStarted(pdir);
    store.write(DEFAULT_POLICY);
    const pins = () => store.get().toolchainPins;
    const root = tmp();
    const bin = join(tmp(), 'tool', 'bin');
    makeBin(bin);
    const reg = new ToolchainRegistry(
      join(root, 'toolchains.json'),
      root,
      () => ({ toolchainPaths: [] }),
      tmp(),
    );
    reg.pinned = (h) => pins().includes(h);
    reg.add({ name: 'yt-dlp', bin: [bin] }, 'devops');
    const hash = reg.waiting()[0]?.hash as string;
    const out: string[] = [];
    const d = {
      store,
      held: new HeldStore(pdir),
      passkeys: new PasskeyStore(pdir),
      out: (l: string) => out.push(l),
      toolchains: () => reg,
    };
    await expect(toolchainApprove({ ...d, ask: async () => 'n' }, hash)).rejects.toThrow(/not approved/);
    expect(pins()).toEqual([]);
    await toolchainApprove({ ...d, ask: async () => 'yes' }, hash);
    expect(out.join('\n')).toContain(bin);
    expect(pins()).toEqual([hash]);
    expect(reg.resolve().pathDirs).toContain(bin);
  });
});
