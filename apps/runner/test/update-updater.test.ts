import { existsSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChecksumMismatchError } from '../src/update/apply.ts';
import { readFailed, readPending, writeFailed, writePending } from '../src/update/layout.ts';
import { Updater, type UpdaterOptions, type UpdateStatus } from '../src/update/updater.ts';
import { addVersion, makeInstall, releaseFetch, until } from './update-helpers.ts';

const FAST = {
  firstCheckMinMs: 0,
  firstCheckMaxMs: 0,
  idlePollMs: 5,
  intervalMs: 3_600_000,
  maxIdleWaitMs: 60_000,
};
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let running: Updater[] = [];
afterEach(() => {
  for (const u of running) u.stop();
  running = [];
});

function setup(opts: {
  version?: string;
  server?: { version: string; paused?: boolean } | 'down';
  idle?: () => boolean;
  stage?: UpdaterOptions['stage'];
  mode?: UpdaterOptions['mode'];
  timing?: UpdaterOptions['timing'];
}) {
  const install = makeInstall(opts.version ?? '0.1.0');
  const state = { server: opts.server ?? { version: '0.1.1' } };
  const reports: UpdateStatus[] = [];
  const restart = vi.fn();
  const stage =
    opts.stage ??
    vi.fn(async (_layout, release: { version: string }) => addVersion(install.root, release.version));
  const updater = new Updater({
    layout: install.layout,
    version: opts.version ?? '0.1.0',
    serverUrl: () => 'http://server.test',
    isIdle: opts.idle ?? (() => true),
    restart,
    report: (s) => reports.push(s),
    log: quiet,
    mode: opts.mode === undefined ? 'systemd' : opts.mode,
    fetch: releaseFetch(() => state.server),
    timing: { ...FAST, ...opts.timing },
    stage: stage as UpdaterOptions['stage'],
    scheduleRestartFn: vi.fn(),
  });
  running.push(updater);
  return { ...install, state, reports, restart, stage, updater };
}

describe('update check', () => {
  it('updates to a newer version: switch, marker, restart', async () => {
    const t = setup({});
    await t.updater.check();
    await until(() => t.restart.mock.calls.length > 0);
    expect(readlinkSync(t.layout.current)).toBe(join(t.root, '0.1.1', 'aom-runner'));
    expect(readlinkSync(t.layout.previous)).toBe(t.pkg);
    const pending = readPending(t.layout);
    expect(pending).toMatchObject({ from: '0.1.0', to: '0.1.1' });
    expect((pending?.deadline ?? 0) * 1000).toBeGreaterThan(Date.now());
    expect(t.updater.current.state).toBe('updating');
  });

  it('does nothing when the server offers the same or an older version', async () => {
    for (const v of ['0.1.0', '0.0.9']) {
      const t = setup({ server: { version: v } });
      await t.updater.check();
      expect(t.updater.current).toMatchObject({ state: 'up_to_date', latestVersion: v });
      expect(t.stage).not.toHaveBeenCalled();
      expect(t.restart).not.toHaveBeenCalled();
    }
  });

  it('compares versions numerically (0.1.10 is newer than 0.1.9)', async () => {
    const t = setup({ version: '0.1.9', server: { version: '0.1.10' } });
    await t.updater.check();
    expect(t.stage).toHaveBeenCalledOnce();
  });

  it('keeps its state when the server cannot be reached', async () => {
    const t = setup({ server: 'down' });
    await t.updater.check();
    expect(t.updater.current.state).toBe('up_to_date');
    expect(t.stage).not.toHaveBeenCalled();
  });

  it('reports failed and does not switch when the download fails its checksum', async () => {
    const t = setup({
      stage: vi.fn(async () => {
        throw new ChecksumMismatchError('a'.repeat(64), 'b'.repeat(64));
      }),
    });
    await t.updater.check();
    expect(t.updater.current.state).toBe('failed');
    expect(t.updater.current.detail).toMatch(/checksum/);
    expect(readlinkSync(t.layout.current)).toBe(t.pkg);
    expect(existsSync(t.layout.pendingFile)).toBe(false);
    expect(t.restart).not.toHaveBeenCalled();
  });

  it('does not try a version again that was rolled back on this machine', async () => {
    const t = setup({});
    writeFailed(t.layout, { version: '0.1.1', at: 1, reason: 'no connection' });
    await t.updater.check();
    expect(t.stage).not.toHaveBeenCalled();
    expect(t.updater.current.state).toBe('rolled_back');
    // a newer release is tried
    t.state.server = { version: '0.1.2' };
    await t.updater.check();
    expect(t.stage).toHaveBeenCalledOnce();
  });
});

describe('idle wait', () => {
  it('downloads at once but restarts only when no agent job is running', async () => {
    let busy = true;
    const t = setup({ idle: () => !busy });
    await t.updater.check();
    expect(t.stage).toHaveBeenCalledOnce();
    expect(t.updater.current.state).toBe('pending');
    await new Promise((r) => setTimeout(r, 60));
    expect(t.restart).not.toHaveBeenCalled();
    expect(readlinkSync(t.layout.current)).toBe(t.pkg);
    expect(existsSync(t.layout.pendingFile)).toBe(false);
    busy = false;
    await until(() => t.restart.mock.calls.length > 0);
    expect(readlinkSync(t.layout.current)).toBe(join(t.root, '0.1.1', 'aom-runner'));
  });

  it('updates anyway once the maximum delay is over', async () => {
    const t = setup({ idle: () => false, timing: { maxIdleWaitMs: 40 } });
    await t.updater.check();
    await until(() => t.restart.mock.calls.length > 0);
    expect(readPending(t.layout)?.to).toBe('0.1.1');
  });
});

describe('kill switch', () => {
  it('does not download while the server says updates are paused', async () => {
    const t = setup({ server: { version: '0.1.1', paused: true } });
    await t.updater.check();
    expect(t.updater.current.state).toBe('paused');
    expect(t.stage).not.toHaveBeenCalled();
    expect(t.restart).not.toHaveBeenCalled();
  });

  it('abandons a downloaded update when it is paused before the runner went idle', async () => {
    let busy = true;
    const t = setup({ idle: () => !busy });
    await t.updater.check();
    expect(t.updater.current.state).toBe('pending');
    t.state.server = { version: '0.1.1', paused: true };
    busy = false;
    await until(() => t.updater.current.state === 'paused');
    expect(t.restart).not.toHaveBeenCalled();
    expect(readlinkSync(t.layout.current)).toBe(t.pkg);
  });

  it('resumes when the switch is turned off again', async () => {
    const t = setup({ server: { version: '0.1.1', paused: true } });
    await t.updater.check();
    t.state.server = { version: '0.1.1', paused: false };
    await t.updater.check();
    await until(() => t.restart.mock.calls.length > 0);
  });
});

describe('unmanaged installs', () => {
  it('never updates a runner that was not started by a service manager', () => {
    const t = setup({ mode: null });
    t.updater.start();
    expect(t.updater.current.state).toBe('unmanaged');
    expect(t.reports.at(-1)?.detail).toMatch(/service manager/);
  });

  it('never updates without the installer layout', () => {
    const u = new Updater({
      layout: null,
      version: '0.1.0',
      serverUrl: () => 'http://server.test',
      isIdle: () => true,
      restart: vi.fn(),
      report: vi.fn(),
      log: quiet,
      mode: 'systemd',
    });
    u.start();
    expect(u.current.state).toBe('unmanaged');
  });

  it('can be turned off on the machine', () => {
    const { layout } = makeInstall('0.1.0');
    const off = new Updater({
      layout,
      version: '0.1.0',
      serverUrl: () => 'http://server.test',
      isIdle: () => true,
      restart: vi.fn(),
      report: vi.fn(),
      log: quiet,
      mode: 'systemd',
      disabled: true,
    });
    off.start();
    expect(off.current.state).toBe('unmanaged');
    expect(off.current.detail).toMatch(/AOM_RUNNER_AUTO_UPDATE/);
  });
});

describe('probation after an update', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  it('rolls back to the previous version when the new one never connects', async () => {
    const t = setup({ version: '0.1.1' });
    const oldPkg = addVersion(t.root, '0.1.0');
    writePending(t.layout, { from: '0.1.0', to: '0.1.1', deadline: nowSec() - 1 });
    t.updater.start();
    await until(() => t.restart.mock.calls.length > 0);
    expect(readlinkSync(t.layout.current)).toBe(oldPkg);
    expect(existsSync(t.layout.pendingFile)).toBe(false);
    expect(readFailed(t.layout)?.version).toBe('0.1.1');
    expect(t.updater.current.state).toBe('rolled_back');
  });

  it('does not roll back while the server is unreachable', async () => {
    const t = setup({ version: '0.1.1', server: 'down' });
    addVersion(t.root, '0.1.0');
    writePending(t.layout, { from: '0.1.0', to: '0.1.1', deadline: nowSec() - 1 });
    t.updater.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(t.restart).not.toHaveBeenCalled();
    expect(existsSync(t.layout.pendingFile)).toBe(true);
  });

  it('confirms the update when the new version connects, and prunes older versions', () => {
    const t = setup({ version: '0.1.1' });
    addVersion(t.root, '0.1.0');
    addVersion(t.root, '0.0.9');
    writePending(t.layout, { from: '0.1.0', to: '0.1.1', deadline: nowSec() + 300 });
    t.updater.start();
    t.updater.noteConnected();
    expect(existsSync(t.layout.pendingFile)).toBe(false);
    expect(existsSync(join(t.root, '0.0.9'))).toBe(false);
    expect(existsSync(join(t.root, '0.1.0'))).toBe(true);
    expect(t.restart).not.toHaveBeenCalled();
    expect(t.updater.current.state).toBe('up_to_date');
  });

  it('reports a rollback that the launcher already did', () => {
    const t = setup({ version: '0.1.0' });
    writeFileSync(t.layout.failedFile, 'version=0.1.1\nat=1\nreason=did not start or connect in time\n');
    t.updater.start();
    expect(t.updater.current.state).toBe('rolled_back');
    expect(t.updater.current.detail).toMatch(/0\.1\.1/);
  });
});

describe('safe mode: a runner version pin from the platform team', () => {
  const SHA = 'a'.repeat(64);
  /** A server that offers 0.1.5 as the latest release and any pinned version on request. */
  const pinServer = (paused = false): typeof fetch =>
    (async (input: URL | string) => {
      const asked = new URL(String(input)).searchParams.get('version');
      const version = asked ?? '0.1.5';
      return new Response(
        JSON.stringify({
          version,
          sha256: SHA,
          size: 10,
          url: `http://server.test/api/runner/release/aom-runner-${version}.tgz`,
          autoUpdatePaused: paused,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

  function setupPin(version: string, paused = false) {
    const install = makeInstall(version);
    const restart = vi.fn();
    const stage = vi.fn(async (_l: unknown, release: { version: string }) =>
      addVersion(install.root, release.version),
    );
    const updater = new Updater({
      layout: install.layout,
      version,
      serverUrl: () => 'http://server.test',
      isIdle: () => true,
      restart,
      report: () => undefined,
      log: quiet,
      mode: 'systemd',
      fetch: pinServer(paused),
      timing: FAST,
      stage: stage as UpdaterOptions['stage'],
      scheduleRestartFn: vi.fn(),
    });
    running.push(updater);
    return { ...install, restart, stage, updater };
  }

  it('rolls back to an OLDER pinned version (the normal cycle never goes down)', async () => {
    const t = setupPin('0.1.4');
    t.updater.setPin('0.1.2');
    await until(() => t.restart.mock.calls.length > 0);
    expect(readlinkSync(t.layout.current)).toBe(join(t.root, '0.1.2', 'aom-runner'));
    expect(readPending(t.layout)).toMatchObject({ from: '0.1.4', to: '0.1.2' });
  });

  it('stays where it is when already on the pinned version, and does not follow the newer release', async () => {
    const t = setupPin('0.1.2');
    t.updater.setPin('0.1.2');
    await t.updater.check();
    expect(t.stage).not.toHaveBeenCalled();
    expect(t.restart).not.toHaveBeenCalled();
    expect(t.updater.current.detail).toMatch(/Pinned to 0\.1\.2/);
  });

  it('follows the pin even while automatic updates are paused, and unpinning goes back to the latest', async () => {
    const t = setupPin('0.1.4', true);
    t.updater.setPin('0.1.3');
    await until(() => t.restart.mock.calls.length > 0);
    expect(readPending(t.layout)).toMatchObject({ to: '0.1.3' });
    const u = setupPin('0.1.3');
    u.updater.setPin('0.1.3');
    await u.updater.check();
    u.updater.setPin(null);
    await until(() => u.restart.mock.calls.length > 0);
    expect(readPending(u.layout)).toMatchObject({ from: '0.1.3', to: '0.1.5' });
  });
});

describe('checkNow ("Check for updates" in the web app)', () => {
  it('says up to date when the server offers the same version', async () => {
    const t = setup({ server: { version: '0.1.0' } });
    expect(await t.updater.checkNow()).toMatchObject({ outcome: 'up_to_date', version: '0.1.0' });
    expect(t.stage).not.toHaveBeenCalled();
    expect(quiet.info).toHaveBeenCalledWith(expect.stringContaining('update check on request: up_to_date'));
  });

  it('finds a newer version and reuses the download path, then waits for idle before switching', async () => {
    let idle = false;
    const t = setup({ idle: () => idle });
    expect(await t.updater.checkNow()).toMatchObject({ outcome: 'update_found', version: '0.1.1' });
    expect(t.stage).toHaveBeenCalledOnce();
    expect(t.updater.current.state).toBe('pending');
    await new Promise((r) => setTimeout(r, 40));
    expect(t.restart).not.toHaveBeenCalled(); // busy: no forced restart
    idle = true;
    await until(() => t.restart.mock.calls.length > 0);
    expect(readPending(t.layout)).toMatchObject({ from: '0.1.0', to: '0.1.1' });
  });

  it('joins a check or download already running instead of starting another', async () => {
    let release: (() => void) | undefined;
    let installRoot = '';
    const t = setup({
      stage: vi.fn(async (_layout, r: { version: string }) => {
        await new Promise<void>((done) => {
          release = done;
        });
        return addVersion(installRoot, r.version);
      }) as UpdaterOptions['stage'],
      idle: () => false,
    });
    installRoot = t.root;
    const a = t.updater.checkNow();
    const b = t.updater.checkNow();
    await until(() => release !== undefined);
    expect(t.stage).toHaveBeenCalledOnce();
    release?.();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(ra.outcome).toBe('update_found');
    expect(t.stage).toHaveBeenCalledOnce();
  });

  it('reports paused and downloads nothing while the platform kill switch is on', async () => {
    const t = setup({ server: { version: '0.1.1', paused: true } });
    expect(await t.updater.checkNow()).toMatchObject({ outcome: 'paused', version: '0.1.1' });
    expect(t.stage).not.toHaveBeenCalled();
  });

  it('reports disabled when AOM_RUNNER_AUTO_UPDATE=0 or the install is not managed', async () => {
    const { layout } = makeInstall('0.1.0');
    const off = new Updater({
      layout,
      version: '0.1.0',
      serverUrl: () => 'http://server.test',
      isIdle: () => true,
      restart: vi.fn(),
      report: vi.fn(),
      log: quiet,
      mode: 'systemd',
      disabled: true,
    });
    off.start();
    expect(await off.checkNow()).toMatchObject({
      outcome: 'disabled',
      detail: expect.stringMatching(/AOM_RUNNER_AUTO_UPDATE/),
    });
    const hand = setup({ mode: null });
    hand.updater.start();
    expect((await hand.updater.checkNow()).outcome).toBe('disabled');
  });

  it('reports failed when the server cannot be reached or the download fails', async () => {
    const down = setup({ server: 'down' });
    expect(await down.updater.checkNow()).toMatchObject({ outcome: 'failed' });
    const bad = setup({
      stage: vi.fn(async () => {
        throw new ChecksumMismatchError('a'.repeat(64), 'b'.repeat(64));
      }),
    });
    const r = await bad.updater.checkNow();
    expect(r.outcome).toBe('failed');
    expect(r.detail).toMatch(/checksum/);
  });
});
