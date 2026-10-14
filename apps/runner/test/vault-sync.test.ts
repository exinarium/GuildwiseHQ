import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import { VaultManager } from '../src/vaults/manager.ts';
import { syncVault } from '../src/vaults/sync.ts';
import { cleanupTmp, sh, tmp, waitUntil } from './helpers.ts';
import {
  IDENTITY,
  makeEmptyOrigin,
  makeVault,
  originFile,
  originLog,
  pushFromOther,
} from './vault-fixtures.ts';

cleanupTmp();

const input = (v: { origin: string; mine: string }) => ({
  dir: v.mine,
  remoteUrl: v.origin,
  identity: IDENTITY,
  workstationName: 'Desk',
});
const write = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
};

describe('syncVault (docs/ARCHITECTURE.md section 16.3)', () => {
  it('clones a missing vault', async () => {
    const v = makeVault({ 'standing-orders.md': 'be kind\n' });
    const r = await syncVault(input(v));
    expect(r).toMatchObject({ status: 'ok', cloned: true, committed: false, pushed: false });
    expect(readFileSync(join(v.mine, 'standing-orders.md'), 'utf8')).toBe('be kind\n');
  });

  it('commits local edits with the DevOps identity and pushes them', async () => {
    const v = makeVault();
    await syncVault(input(v));
    write(v.mine, 'projects/toy/PROJECT.md', '# Toy\nuse pnpm\n');
    const r = await syncVault(input(v));
    expect(r).toMatchObject({ status: 'ok', committed: true, pushed: true });
    const [latest] = originLog(v);
    expect(latest).toMatch(/^Workstation Owner\|Update notes \d{4}-\d\d-\d\dT/);
    expect(originFile(v, 'projects/toy/PROJECT.md')).toBe('# Toy\nuse pnpm\n');
    // nothing new: a no-op pass
    expect(await syncVault(input(v))).toMatchObject({
      status: 'ok',
      committed: false,
      pulled: false,
      pushed: false,
    });
  });

  it('pulls remote edits', async () => {
    const v = makeVault();
    await syncVault(input(v));
    pushFromOther(v, 'standing-orders.md', 'new rule\n');
    const r = await syncVault(input(v));
    expect(r).toMatchObject({ status: 'ok', pulled: true, pushed: false });
    expect(readFileSync(join(v.mine, 'standing-orders.md'), 'utf8')).toBe('new rule\n');
  });

  it('merges edits to different files on both sides and pushes the result', async () => {
    const v = makeVault({ 'a.md': 'a\n', 'b.md': 'b\n' });
    await syncVault(input(v));
    write(v.mine, 'a.md', 'a local\n');
    pushFromOther(v, 'b.md', 'b remote\n');
    const r = await syncVault(input(v));
    expect(r).toMatchObject({ status: 'ok', committed: true, pulled: true, pushed: true });
    expect(originFile(v, 'a.md')).toBe('a local\n');
    expect(originFile(v, 'b.md')).toBe('b remote\n');
    expect(sh(v.mine, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('a conflicting edit aborts the rebase, lists the files and leaves the clone clean', async () => {
    const v = makeVault({ 'notes.md': 'line one\nline two\n' });
    await syncVault(input(v));
    write(v.mine, 'notes.md', 'line one\nlocal two\n');
    pushFromOther(v, 'notes.md', 'line one\nremote two\n');
    const before = sh(v.origin, 'git', ['rev-parse', 'main']);
    const r = await syncVault(input(v));
    expect(r).toEqual({ status: 'conflict', files: ['notes.md'] });
    expect(sh(v.origin, 'git', ['rev-parse', 'main'])).toBe(before); // nothing was pushed
    expect(sh(v.mine, 'git', ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(v.mine, '.git', 'rebase-merge'))).toBe(false);
    expect(readFileSync(join(v.mine, 'notes.md'), 'utf8')).toBe('line one\nlocal two\n'); // the local edit survives
  });

  it('pushes the first commit into an empty remote', async () => {
    const e = makeEmptyOrigin();
    const r1 = await syncVault(input(e));
    expect(r1).toMatchObject({ status: 'ok', cloned: true, pushed: false });
    write(e.mine, 'README.md', '# fresh\n');
    const r2 = await syncVault(input(e));
    expect(r2).toMatchObject({ status: 'ok', committed: true, pushed: true });
    expect(sh(e.origin, 'git', ['show', 'main:README.md'])).toBe('# fresh');
  });

  it('reports an unreachable remote as an error without touching local edits', async () => {
    const v = makeVault();
    await syncVault(input(v));
    write(v.mine, 'draft.md', 'wip\n');
    const gone = { ...input(v) };
    sh(v.mine, 'git', ['remote', 'set-url', 'origin', join(v.root, 'does-not-exist.git')]);
    const r = await syncVault(gone);
    expect(r.status).toBe('error');
    expect(readFileSync(join(v.mine, 'draft.md'), 'utf8')).toBe('wip\n');
    expect(sh(v.mine, 'git', ['log', '-1', '--format=%s'])).toMatch(/^Update notes /); // committed locally, pushed later
  });

  it('a failed clone reports an error', async () => {
    const dir = tmp();
    const r = await syncVault({ ...input({ origin: join(dir, 'nope.git'), mine: join(dir, 'clone') }) });
    expect(r.status).toBe('error');
  });
});

describe('VaultManager', () => {
  function manager(secondMs = 20) {
    const root = tmp('aom-m3-runner-');
    const paths = runnerPaths(root);
    const sent: Array<{ type: string; payload: Record<string, any> }> = [];
    const m = new VaultManager({
      paths,
      secondMs,
      transport: { send: (type, payload) => void sent.push({ type, payload }) },
    });
    return { m, paths, sent, root };
  }
  const cfg = (vaultId: string, origin: string, syncIntervalSec = 1) => ({
    vaults: [{ vaultId, kind: 'org' as const, name: 'Org', remoteUrl: origin, syncIntervalSec }],
    identity: IDENTITY,
    workstationName: 'Desk',
    resume: [] as string[],
  });

  it('local edits are pushed and remote edits pulled within one interval', async () => {
    const v = makeVault();
    const { m, paths, sent } = manager();
    m.configure(cfg('v1', v.origin));
    const dir = join(paths.vaults, 'v1');
    await waitUntil(() => existsSync(join(dir, 'README.md')), 5000, 'initial clone');
    // local edit
    write(dir, 'projects/toy/decisions/d.md', 'decision\n');
    await waitUntil(
      () => originLog(v).some((l) => l.includes('Update notes')),
      5000,
      'push within the interval',
    );
    expect(originFile(v, 'projects/toy/decisions/d.md')).toBe('decision\n');
    // remote edit
    pushFromOther(v, 'standing-orders.md', 'from elsewhere\n');
    await waitUntil(() => existsSync(join(dir, 'standing-orders.md')), 5000, 'pull within the interval');
    expect(readFileSync(join(dir, 'standing-orders.md'), 'utf8')).toBe('from elsewhere\n');
    // status reports carry timestamps
    const status = sent.filter((s) => s.type === 'vault.status' && !s.payload.error).at(-1)!;
    expect(status.payload.vaultId).toBe('v1');
    expect(status.payload.lastPullAt).toMatch(/^\d{4}-/);
    expect(status.payload.lastPushAt).toMatch(/^\d{4}-/);
    expect(await m.report()).toEqual([{ vaultId: 'v1', localPath: dir, clean: true }]);
    m.stop();
  });

  it('a conflict raises vault.conflict once, pauses the vault, and resume resyncs after the manager resolved it', async () => {
    const v = makeVault({ 'notes.md': 'one\ntwo\n' });
    const { m, paths, sent } = manager(60_000); // timers effectively off: the test drives each pass
    m.configure(cfg('v2', v.origin, 3600));
    const dir = join(paths.vaults, 'v2');
    await m.syncNow('v2');
    expect(existsSync(join(dir, 'notes.md'))).toBe(true);
    write(dir, 'notes.md', 'one\nlocal\n');
    pushFromOther(v, 'notes.md', 'one\nremote\n');
    const r = await m.syncNow('v2');
    expect(r).toEqual({ status: 'conflict', files: ['notes.md'] });
    expect(sent.filter((s) => s.type === 'vault.conflict')).toEqual([
      { type: 'vault.conflict', payload: { vaultId: 'v2', files: ['notes.md'] } },
    ]);
    expect(m.isPaused('v2')).toBe(true);
    expect(sent.some((s) => s.type === 'vault.status' && /conflict/.test(String(s.payload.error)))).toBe(
      true,
    );

    // later passes: still paused, still exactly one conflict report, the remote is untouched
    const before = sh(v.origin, 'git', ['rev-parse', 'main']);
    expect(await m.syncNow('v2')).toEqual({ status: 'paused' });
    expect(await m.syncNow('v2')).toEqual({ status: 'paused' });
    expect(sent.filter((s) => s.type === 'vault.conflict')).toHaveLength(1);
    expect(sh(v.origin, 'git', ['rev-parse', 'main'])).toBe(before);

    // the manager resolves it by hand: take the remote version, then the desk resolve sends configure{resume}
    sh(dir, 'git', ['reset', '--hard', 'origin/main']);
    m.configure({ ...cfg('v2', v.origin, 3600), resume: ['v2'] });
    expect(m.isPaused('v2')).toBe(false);
    await m.syncNow('v2'); // queued behind the resume pass
    write(dir, 'after.md', 'back in business\n');
    expect(await m.syncNow('v2')).toMatchObject({ status: 'ok', pushed: true });
    expect(originFile(v, 'after.md')).toBe('back in business\n');
    m.stop();
  });

  it('keeps config and pause state across a restart, and forgets vaults the server dropped', async () => {
    const v = makeVault({ 'notes.md': 'one\ntwo\n' });
    const a = manager(60_000); // timers effectively off: drive syncs by hand
    a.m.configure(cfg('v3', v.origin, 3600));
    await a.m.syncNow('v3');
    write(join(a.paths.vaults, 'v3'), 'notes.md', 'one\nlocal\n');
    pushFromOther(v, 'notes.md', 'one\nremote\n');
    await a.m.syncNow('v3');
    expect(a.m.isPaused('v3')).toBe(true);
    a.m.stop();

    const again = new VaultManager({ paths: a.paths, secondMs: 60_000, transport: { send() {} } });
    expect(again.configured()).toEqual(['v3']);
    expect(again.isPaused('v3')).toBe(true);
    again.configure({ ...cfg('v3', v.origin), vaults: [] });
    expect(again.configured()).toEqual([]);
    expect(again.isPaused('v3')).toBe(false);
    again.stop();
    rmSync(a.root, { recursive: true, force: true });
  });

  it('an error is reported as status with the message and retried on the next tick', async () => {
    const dir = tmp();
    const { m, sent } = manager();
    m.configure(cfg('v4', join(dir, 'nope.git')));
    await waitUntil(
      () => sent.some((s) => s.type === 'vault.status' && s.payload.error),
      5000,
      'error status',
    );
    const e = sent.find((s) => s.payload.error)!;
    expect(e.payload.error).toMatch(/clone/);
    const n = sent.length;
    await waitUntil(() => sent.length > n + 1, 3000, 'retry');
    m.stop();
  });
});

describe('syncVault refuses dangerous remotes (review M1, M5)', () => {
  it.each([
    ['option-like', '--upload-pack=touch /tmp/aom-pwned'],
    ['credentials', 'https://user:token@example.com/v.git'],
    ['ext transport', 'ext::sh -c touch% /tmp/aom-pwned'],
  ])('does not clone a %s URL', async (_name, remoteUrl) => {
    const dir = join(tmp(), 'clone');
    const r = await syncVault({ dir, remoteUrl, identity: IDENTITY, workstationName: 'Desk' });
    expect(r.status).toBe('error');
    expect(existsSync(dir)).toBe(false);
    expect(existsSync('/tmp/aom-pwned')).toBe(false);
  });
});
