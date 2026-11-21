import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type InstallLayout, layoutFor } from '../src/update/layout.ts';
import { manifestText, minisignSign } from './minisign-helper.ts';

/** An install in a temp folder: `<root>/<version>/aom-runner` with `current` pointing at it, as the installer lays it out. */
export function makeInstall(version = '0.1.0'): { root: string; pkg: string; layout: InstallLayout } {
  const root = mkdtempSync(join(tmpdir(), 'aom-update-'));
  const pkg = addVersion(root, version);
  symlinkSync(pkg, join(root, 'current'));
  return { root, pkg, layout: layoutFor(root, pkg) };
}

/** An unpacked version next to the others (what a download would leave). */
export function addVersion(root: string, version: string): string {
  const pkg = join(root, version, 'aom-runner');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'dist', 'aom-runner.mjs'), '');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'aom-runner', version }));
  return pkg;
}

export const SHA = 'a'.repeat(64);

/**
 * A fetch that answers the 1.10.0 release paths (`/api/runner/releases/manifest.json` and its `.minisig`, signed with the
 * test fixture key) and the legacy `GET /api/runner/release` with whatever `release()` returns right now.
 */
export function releaseFetch(release: () => { version: string; paused?: boolean } | 'down'): typeof fetch {
  return (async (input: string | URL | Request) => {
    const r = release();
    if (r === 'down') throw new Error('connect ECONNREFUSED');
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      .pathname;
    const manifest = manifestText(r.version, SHA);
    if (path === '/api/runner/releases/manifest.json')
      return new Response(manifest, {
        status: 200,
        headers: { 'x-runner-updates-paused': r.paused ? 'true' : 'false' },
      });
    if (path === '/api/runner/releases/manifest.json.minisig')
      return new Response(minisignSign(manifest, 'test.key', `guildwise-runner ${r.version}`), {
        status: 200,
      });
    return new Response(
      JSON.stringify({
        version: r.version,
        sha256: SHA,
        size: 10,
        url: `http://server.test/api/runner/release/aom-runner-${r.version}.tgz`,
        autoUpdatePaused: r.paused ?? false,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}
