import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ChecksumMismatchError,
  detectServiceMode,
  pruneVersions,
  scheduleRestart,
  stageRelease,
  switchBack,
  switchTo,
} from '../src/update/apply.ts';
import { detectLayout, readFailed, readPending, writeFailed, writePending } from '../src/update/layout.ts';
import { addVersion, makeInstall, SHA } from './update-helpers.ts';

/** A real .tgz holding aom-runner/dist/aom-runner.mjs, and a fetch that serves it. */
function tarball(version: string): { sha256: string; fetch: typeof fetch } {
  const src = mkdtempSync(join(tmpdir(), 'aom-tgz-'));
  mkdirSync(join(src, 'aom-runner', 'dist'), { recursive: true });
  writeFileSync(join(src, 'aom-runner', 'dist', 'aom-runner.mjs'), `// ${version}\n`);
  writeFileSync(join(src, 'aom-runner', 'package.json'), JSON.stringify({ version }));
  const file = join(src, 'r.tgz');
  execFileSync('tar', ['-C', src, '-czf', file, 'aom-runner']);
  const bytes = readFileSync(file);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    fetch: (async () => new Response(bytes, { status: 200 })) as typeof fetch,
  };
}

describe('stageRelease', () => {
  it('downloads, verifies and unpacks next to the current version', async () => {
    const { layout, root } = makeInstall('0.1.0');
    const t = tarball('0.1.1');
    const pkg = await stageRelease(
      layout,
      { version: '0.1.1', sha256: t.sha256, url: 'http://x/r.tgz' },
      t.fetch,
    );
    expect(pkg).toBe(join(root, '0.1.1', 'aom-runner'));
    expect(readFileSync(join(pkg, 'dist', 'aom-runner.mjs'), 'utf8')).toContain('0.1.1');
    expect(readFileSync(join(root, '0.1.1', '.sha256'), 'utf8')).toBe(t.sha256);
    expect(existsSync(join(root, '.update-0.1.1'))).toBe(false);
    // the running version is untouched
    expect(readlinkSync(join(root, 'current'))).toBe(layout.packageDir);
  });

  it('rejects a download whose sha256 does not match, and unpacks nothing', async () => {
    const { layout, root } = makeInstall('0.1.0');
    const t = tarball('0.1.1');
    const unpack = vi.fn();
    await expect(
      stageRelease(layout, { version: '0.1.1', sha256: SHA, url: 'http://x/r.tgz' }, t.fetch, { unpack }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(unpack).not.toHaveBeenCalled();
    expect(existsSync(join(root, '0.1.1'))).toBe(false);
    expect(existsSync(join(root, '.update-0.1.1'))).toBe(false);
  });

  it('refuses an archive that holds no runner', async () => {
    const { layout, root } = makeInstall('0.1.0');
    const t = tarball('0.1.1');
    await expect(
      stageRelease(layout, { version: '0.1.1', sha256: t.sha256, url: 'u' }, t.fetch, {
        unpack: async (_a, into) => {
          mkdirSync(join(into, 'aom-runner'), { recursive: true });
        },
      }),
    ).rejects.toThrow(/does not hold a runner/);
    expect(existsSync(join(root, '0.1.1'))).toBe(false);
  });

  it('reuses a version that is already unpacked with the same checksum', async () => {
    const { layout, root } = makeInstall('0.1.0');
    const pkg = addVersion(root, '0.1.1');
    writeFileSync(join(root, '0.1.1', '.sha256'), SHA);
    const download = vi.fn();
    expect(await stageRelease(layout, { version: '0.1.1', sha256: SHA, url: 'u' }, fetch, { download })).toBe(
      pkg,
    );
    expect(download).not.toHaveBeenCalled();
  });

  it('fails on an HTTP error', async () => {
    const { layout } = makeInstall('0.1.0');
    const f = (async () => new Response('no', { status: 404 })) as typeof fetch;
    await expect(stageRelease(layout, { version: '0.1.1', sha256: SHA, url: 'u' }, f)).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe('switching versions', () => {
  it('moves current to the new version and remembers the old one as previous', () => {
    const { layout, root } = makeInstall('0.1.0');
    const next = addVersion(root, '0.1.1');
    switchTo(layout, next, layout.packageDir);
    expect(readlinkSync(layout.current)).toBe(next);
    expect(readlinkSync(layout.previous)).toBe(join(root, '0.1.0', 'aom-runner'));
    switchBack(layout, join(root, '0.1.0', 'aom-runner'));
    expect(readlinkSync(layout.current)).toBe(join(root, '0.1.0', 'aom-runner'));
  });

  it('will not roll back to a version that is gone', () => {
    const { layout, root } = makeInstall('0.1.0');
    expect(() => switchBack(layout, join(root, '0.0.9', 'aom-runner'))).toThrow(/gone/);
  });

  it('prunes everything except the versions to keep', () => {
    const { layout, root } = makeInstall('0.1.1');
    addVersion(root, '0.1.0');
    addVersion(root, '0.0.9');
    expect(pruneVersions(layout, ['0.1.1', '0.1.0']).sort()).toEqual(['0.0.9']);
    expect(existsSync(join(root, '0.0.9'))).toBe(false);
    expect(existsSync(join(root, '0.1.0'))).toBe(true);
  });
});

describe('layout and markers', () => {
  it('detects the installer layout from the entry file, and nothing else', () => {
    const { layout, pkg } = makeInstall('0.1.0');
    expect(detectLayout(join(pkg, 'dist', 'aom-runner.mjs'))?.root).toBe(layout.root);
    // a checkout, or a copy that current does not point at
    const stray = mkdtempSync(join(tmpdir(), 'aom-stray-'));
    mkdirSync(join(stray, 'dist'), { recursive: true });
    writeFileSync(join(stray, 'dist', 'aom-runner.mjs'), '');
    expect(detectLayout(join(stray, 'dist', 'aom-runner.mjs'))).toBeNull();
    expect(detectLayout(undefined)).toBeNull();
  });

  it('round-trips the key=value markers the shell launcher reads', () => {
    const { layout } = makeInstall('0.1.0');
    writePending(layout, { from: '0.1.0', to: '0.1.1', deadline: 123 });
    expect(readFileSync(layout.pendingFile, 'utf8')).toBe('from=0.1.0\nto=0.1.1\ndeadline=123\n');
    expect(readPending(layout)).toEqual({ from: '0.1.0', to: '0.1.1', deadline: 123 });
    writeFailed(layout, { version: '0.1.1', at: 5, reason: 'did not\nconnect' });
    expect(readFailed(layout)).toEqual({ version: '0.1.1', at: 5, reason: 'did not connect' });
  });

  it('finds out how the runner is kept running', () => {
    const { layout } = makeInstall('0.1.0');
    expect(detectServiceMode(layout, {})).toBeNull();
    expect(detectServiceMode(layout, { INVOCATION_ID: 'x', JOURNAL_STREAM: '1:2' })).toBe('systemd');
    expect(detectServiceMode(layout, { XPC_SERVICE_NAME: 'com.guildwisehq.runner' })).toBe('launchd');
    writeFileSync(layout.fallbackLauncher, '#!/bin/sh\n');
    expect(detectServiceMode(layout, {})).toBe('background');
    writeFileSync(layout.modeFile, 'systemd\n');
    expect(detectServiceMode(layout, {})).toBe('systemd');
  });

  it('starts a restart helper only where nothing supervises the runner', () => {
    const { layout } = makeInstall('0.1.0');
    const spawnFn = vi.fn(() => ({ unref: vi.fn() })) as never;
    scheduleRestart(layout, 'systemd', spawnFn);
    scheduleRestart(layout, 'launchd', spawnFn);
    expect(spawnFn).not.toHaveBeenCalled();
    scheduleRestart(layout, 'background', spawnFn);
    expect(spawnFn).toHaveBeenCalledOnce();
  });
});
