import { existsSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchVerifiedRelease, UntrustedReleaseError } from '../src/update/apply.ts';
import { MIN_TRUSTED_RUNNER } from '../src/update/floor.ts';
import { readPending, writePending } from '../src/update/layout.ts';
import { compareVersions } from '../src/update/semver.ts';
import { Updater, type UpdaterOptions } from '../src/update/updater.ts';
import { acceptablePin, verifyUpdate } from '../src/update/verify.ts';
import { RUNNER_VERSION } from '../src/version.ts';
import { manifestText, minisignSign, OTHER_PUB, TEST_PUB } from './minisign-helper.ts';
import { addVersion, makeInstall, releaseFetch, SHA, until } from './update-helpers.ts';

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ORIGIN = 'https://hq.example';
const noUnsigned = { allowUnsignedUpdatesFrom: [] as string[] };
const signed = (v: string, key: 'test.key' | 'other.key' = 'test.key') => {
  const text = manifestText(v, SHA);
  return { manifestText: text, minisig: minisignSign(text, key, `guildwise-runner ${v}`), origin: ORIGIN };
};

describe('the version floor (R18-U [rv4-1])', () => {
  it('is compiled in, at or below this runner version and equal to it for the 1.10.0 release', () => {
    expect(compareVersions(MIN_TRUSTED_RUNNER, RUNNER_VERSION)).toBeLessThanOrEqual(0);
    expect(MIN_TRUSTED_RUNNER).toBe('1.10.0');
  });

  it('refuses a runner.pin or welcome.runnerPin below it', () => {
    expect(acceptablePin('1.9.9')).toMatchObject({ ok: false });
    expect(acceptablePin(MIN_TRUSTED_RUNNER)).toEqual({ ok: true });
    expect(acceptablePin(null)).toEqual({ ok: true });
  });
});

describe('verifyUpdate: signature, unsigned origins, floor (R18-U, R29)', () => {
  const base = { current: '1.10.0', pin: null, trustedKey: TEST_PUB, policy: noUnsigned };

  it('accepts a release signed with the trusted key', () => {
    expect(verifyUpdate({ ...base, fetched: signed('1.10.2') })).toMatchObject({ ok: true, signed: true });
  });

  it('refuses a tampered manifest, a signature by another key and the placeholder key', () => {
    const s = signed('1.10.2');
    expect(
      verifyUpdate({ ...base, fetched: { ...s, manifestText: s.manifestText.replace(SHA, 'b'.repeat(64)) } })
        .ok,
    ).toBe(false);
    expect(verifyUpdate({ ...base, fetched: signed('1.10.2', 'other.key') }).ok).toBe(false);
    expect(verifyUpdate({ ...base, trustedKey: 'PLACEHOLDER', fetched: s }).ok).toBe(false);
    // the other key trusts only its own signatures
    expect(verifyUpdate({ ...base, trustedKey: OTHER_PUB, fetched: signed('1.10.2', 'other.key') }).ok).toBe(
      true,
    );
  });

  it('refuses an unsigned manifest unless the origin is allowed locally or is the legacy update origin', () => {
    const unsigned = { manifestText: manifestText('1.10.2', SHA), minisig: null, origin: ORIGIN };
    expect(verifyUpdate({ ...base, fetched: unsigned }).ok).toBe(false);
    expect(
      verifyUpdate({ ...base, fetched: unsigned, policy: { allowUnsignedUpdatesFrom: [ORIGIN] } }).ok,
    ).toBe(true);
    expect(
      verifyUpdate({
        ...base,
        fetched: unsigned,
        policy: { allowUnsignedUpdatesFrom: ['https://other.example'] },
      }).ok,
    ).toBe(false);
    // R29: a runner that arrived by the old in-place update trusts exactly its own pairing origin
    expect(
      verifyUpdate({ ...base, fetched: unsigned, policy: { ...noUnsigned, legacyUpdateOrigin: ORIGIN } }).ok,
    ).toBe(true);
    expect(
      verifyUpdate({
        ...base,
        fetched: unsigned,
        policy: { ...noUnsigned, legacyUpdateOrigin: 'https://evil.example' },
      }).ok,
    ).toBe(false);
  });

  it('a bad signature is refused even from an origin allowed to serve unsigned updates', () => {
    const s = signed('1.10.2', 'other.key');
    expect(verifyUpdate({ ...base, fetched: s, policy: { allowUnsignedUpdatesFrom: [ORIGIN] } }).ok).toBe(
      false,
    );
  });

  it('refuses a release below the floor, even a signed one, and a pin of another version', () => {
    expect(verifyUpdate({ ...base, fetched: signed('1.9.9') })).toMatchObject({ ok: false });
    expect(verifyUpdate({ ...base, pin: '1.10.1', fetched: signed('1.10.2') }).ok).toBe(false);
    expect(verifyUpdate({ ...base, current: '1.10.3', pin: '1.10.1', fetched: signed('1.10.1') }).ok).toBe(
      true,
    );
  });
});

describe('fetchVerifiedRelease (the 1.10.0 release paths)', () => {
  it('reads manifest.json and its signature from /api/runner/releases and builds the tgz url from the manifest', async () => {
    const r = await fetchVerifiedRelease('http://server.test', {
      current: '1.10.0',
      pin: null,
      trustedKey: TEST_PUB,
      policy: noUnsigned,
      fetch: releaseFetch(() => ({ version: '1.10.2', paused: true })),
    });
    expect(r).toMatchObject({ version: '1.10.2', sha256: SHA, signed: true, autoUpdatePaused: true });
    expect(r.url).toBe('http://server.test/api/runner/releases/aom-runner-1.10.2.tgz');
    expect(r.proof.minisig).toMatch(/trusted comment: guildwise-runner 1.10.2/);
  });

  it('an older server without the new paths serves an unsigned release: refused unless the origin is allowed', async () => {
    const legacyOnly = (async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith('/api/runner/releases/')) return new Response('', { status: 404 });
      return releaseFetch(() => ({ version: '1.10.2' }))(input);
    }) as typeof fetch;
    const opts = { current: '1.10.0', pin: null, trustedKey: TEST_PUB, fetch: legacyOnly };
    await expect(
      fetchVerifiedRelease('http://server.test', { ...opts, policy: noUnsigned }),
    ).rejects.toBeInstanceOf(UntrustedReleaseError);
    const ok = await fetchVerifiedRelease('http://server.test', {
      ...opts,
      policy: { allowUnsignedUpdatesFrom: ['http://server.test'] },
    });
    expect(ok).toMatchObject({ version: '1.10.2', signed: false });
  });
});

describe('the updater with signed releases and the floor', () => {
  let running: Updater[] = [];
  afterEach(() => {
    for (const u of running) u.stop();
    running = [];
  });
  const FAST = {
    firstCheckMinMs: 0,
    firstCheckMaxMs: 0,
    idlePollMs: 5,
    intervalMs: 3_600_000,
    maxIdleWaitMs: 60_000,
  };

  function setup(version: string, server: () => { version: string }, extra: Partial<UpdaterOptions> = {}) {
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
      fetch: releaseFetch(server),
      timing: FAST,
      stage: stage as UpdaterOptions['stage'],
      scheduleRestartFn: vi.fn(),
      trustedKey: TEST_PUB,
      ...extra,
    });
    running.push(updater);
    return { ...install, restart, stage, updater };
  }

  it('refuses a release signed by an untrusted key: nothing is downloaded', async () => {
    const t = setup('1.10.0', () => ({ version: '1.10.2' }), { trustedKey: OTHER_PUB });
    await t.updater.check();
    expect(t.stage).not.toHaveBeenCalled();
    expect(t.updater.current).toMatchObject({ state: 'failed' });
    expect(t.updater.current.detail).toMatch(/refused/);
  });

  it('an update offered below the floor is refused', async () => {
    const t = setup('1.10.0', () => ({ version: '1.9.9' }));
    t.updater.setPin('1.9.9'); // a pin below the floor is ignored
    await t.updater.check();
    expect(t.stage).not.toHaveBeenCalled();
  });

  it('hands the verified manifest and signature to stageRelease (the proof the new version sends)', async () => {
    const t = setup('1.10.0', () => ({ version: '1.10.2' }));
    await t.updater.check();
    expect(t.stage).toHaveBeenCalledOnce();
    const release = t.stage.mock.calls[0]?.[1] as unknown as {
      proof: { manifestText: string; minisig: string };
    };
    expect(JSON.parse(release.proof.manifestText).version).toBe('1.10.2');
    expect(release.proof.minisig).toMatch(/^untrusted comment:/);
  });

  it('deletes local copies below the floor after a good start', async () => {
    const t = setup('1.10.2', () => ({ version: '1.10.2' }));
    addVersion(t.root, '1.9.0');
    addVersion(t.root, '1.10.1');
    writePending(t.layout, { from: '1.9.0', to: '1.10.2', deadline: Math.floor(Date.now() / 1000) + 300 });
    t.updater.start();
    t.updater.noteConnected();
    await until(() => !existsSync(t.layout.pendingFile));
    expect(existsSync(join(t.root, '1.9.0'))).toBe(false);
    expect(existsSync(join(t.root, '1.10.1'))).toBe(false); // neither running nor the previous one
    expect(existsSync(join(t.root, '1.10.2'))).toBe(true);
  });

  it('rolls back only to a version at or above the floor', async () => {
    const t = setup('1.10.2', () => ({ version: '1.10.2' }), {
      // the server is reachable (probation may decide), but offers nothing right now
      fetch: (async (input: string | URL) =>
        new Response('', {
          status: new URL(String(input)).pathname === '/api/runner/release' ? 200 : 503,
        })) as typeof fetch,
    });
    const old = addVersion(t.root, '1.9.0');
    writePending(t.layout, { from: '1.9.0', to: '1.10.2', deadline: Math.floor(Date.now() / 1000) - 10 });
    t.updater.start();
    await until(() => t.updater.current.state === 'failed');
    expect(t.updater.current.detail).toMatch(/below the floor/);
    expect(readlinkSync(t.layout.current)).toBe(t.pkg);
    expect(readlinkSync(t.layout.current)).not.toBe(old);
    expect(readPending(t.layout)).toBeNull();
    expect(t.restart).not.toHaveBeenCalled();
  });
});
