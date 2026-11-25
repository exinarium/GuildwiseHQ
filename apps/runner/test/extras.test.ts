import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareYtDlpVersions,
  installExtra,
  installYtDlp,
  YTDLP_INSTALL_COMMAND,
  type YtDlpPin,
  ytDlpDoctorLines,
  ytDlpPath,
  ytDlpPlan,
} from '../src/toolchain/extras.ts';
import { YTDLP } from '../src/toolchain/pins.ts';
import { stageDir, toolchainsRoot, type UserInstallDeps } from '../src/toolchain/user-install.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const BODY = '#!/bin/sh\necho 2026.10.26\n';
const BODY_SHA = createHash('sha256').update(BODY).digest('hex');

/** A runner home and fixture deps: downloads write `BODY`, nothing touches the network. */
function world(over: Partial<UserInstallDeps> = {}) {
  const home = realpathSync(tmp('aom-extras-home-'));
  const downloads: string[] = [];
  const deps: Partial<UserInstallDeps> = {
    fetchText: async () => {
      throw new Error('no network in tests');
    },
    download: async (url, dest) => {
      downloads.push(url);
      writeFileSync(dest, BODY);
    },
    home: () => home,
    accountHome: () => home,
    uid: () => 1000,
    platform: 'linux',
    arch: 'x64',
    ...over,
  };
  return { home, root: toolchainsRoot(home), downloads, deps };
}

const fixturePin: YtDlpPin = {
  version: YTDLP.version,
  files: { linux: { file: 'yt-dlp_linux', sha256: BODY_SHA } },
};

describe('yt-dlp plan', () => {
  it('uses the pinned version and sha256 for each platform build', () => {
    for (const [platform, arch, key] of [
      ['linux', 'x64', 'linux'],
      ['linux', 'arm64', 'linux-arm64'],
      ['darwin', 'arm64', 'darwin'],
      ['darwin', 'x64', 'darwin'],
    ] as const) {
      const a = ytDlpPlan(platform, arch)?.archives[0];
      expect(a).toMatchObject({
        url: `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP.version}/${YTDLP.files[key].file}`,
        checksum: { algo: 'sha256', hex: YTDLP.files[key].sha256 },
        format: 'file',
        fileName: 'yt-dlp',
        tool: 'yt-dlp',
        version: YTDLP.version,
        bins: { 'yt-dlp': 'yt-dlp' },
      });
    }
    for (const f of Object.values(YTDLP.files)) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ytDlpPlan('win32', 'x64')).toBeNull();
  });
});

describe('installing yt-dlp', () => {
  it('installs into the toolchains root of the runner home and links bin/yt-dlp', async () => {
    const w = world();
    const r = await installYtDlp(w.deps, () => {}, fixturePin);
    expect(r.ok).toBe(true);
    const link = join(w.root, 'bin', 'yt-dlp');
    expect(readlinkSync(link)).toBe(join(w.root, 'yt-dlp', YTDLP.version, 'yt-dlp'));
    expect(readFileSync(link, 'utf8')).toBe(BODY);
    expect(relative(w.home, realpathSync(link)).startsWith('..')).toBe(false);
    expect(ytDlpPath(w.home)).toBe(link);
    expect(w.downloads).toEqual([
      `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP.version}/yt-dlp_linux`,
    ]);
  });

  it('refuses a download that does not match the pinned sha256 and installs nothing', async () => {
    const w = world();
    const r = await installExtra('yt-dlp', { install: w.deps });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('checksum mismatch: refused');
    expect(r.detail).toContain(YTDLP.files.linux.sha256);
    expect(ytDlpPath(w.home)).toBeNull();
    expect(existsSync(join(w.root, 'yt-dlp'))).toBe(false);
    expect(readdirSync(stageDir(w.root))).toEqual([]);
  });

  it('refuses root and a foreign HOME before downloading anything', async () => {
    const asRoot = world({ uid: () => 0 });
    const r = await installExtra('yt-dlp', { install: asRoot.deps });
    expect(r).toMatchObject({ ok: false });
    expect(r.detail).toContain('root');
    expect(asRoot.downloads).toEqual([]);
    const foreign = world();
    const other = realpathSync(tmp('aom-extras-other-'));
    const f = await installExtra('yt-dlp', { install: { ...foreign.deps, home: () => other } });
    expect(f.ok).toBe(false);
    expect(f.detail).toContain("is not the runner account's home");
    expect(foreign.downloads).toEqual([]);
  });

  it('says so on a platform without a pinned build', async () => {
    const w = world({ platform: 'win32' });
    expect(await installExtra('yt-dlp', { install: w.deps })).toEqual({
      ok: false,
      detail: 'yt-dlp: no pinned build for win32/x64',
    });
  });
});

describe('[S5] ytDlpPath and the doctor', () => {
  /** A yt-dlp on PATH (`/usr/local/bin` style) and, optionally, the toolchains copy. */
  function machine(withOwn: boolean) {
    const home = realpathSync(tmp('aom-extras-doc-'));
    const pathBin = join(home, 'usr-local-bin');
    mkdirSync(pathBin, { recursive: true });
    writeFileSync(join(pathBin, 'yt-dlp'), BODY, { mode: 0o755 });
    const ownBin = join(toolchainsRoot(home), 'bin');
    if (withOwn) {
      mkdirSync(join(toolchainsRoot(home), 'yt-dlp', '2026.08.19'), { recursive: true });
      const target = join(toolchainsRoot(home), 'yt-dlp', '2026.08.19', 'yt-dlp');
      writeFileSync(target, BODY, { mode: 0o755 });
      mkdirSync(ownBin, { recursive: true });
      symlinkSync(target, join(ownBin, 'yt-dlp'));
    }
    return { home, pathBin, ownBin, own: join(ownBin, 'yt-dlp') };
  }

  it('ytDlpPath never falls back to a yt-dlp on PATH', () => {
    const m = machine(false);
    expect(ytDlpPath(m.home)).toBeNull();
    expect(ytDlpPath(machine(true).home)).not.toBeNull();
  });

  it('reports the toolchains copy, warns with the command when it is older than the pin, names the PATH copy as not used', async () => {
    const m = machine(true);
    const ran: string[] = [];
    const lines = await ytDlpDoctorLines({
      home: m.home,
      processHome: m.home,
      pathEnv: [m.ownBin, m.pathBin].join(':'),
      exists: existsSync,
      version: async (bin) => {
        ran.push(bin);
        return '2026.08.19';
      },
      pin: '2026.10.26',
    });
    expect(ran).toEqual([m.own]);
    expect(lines[0]).toEqual({
      ok: 'warn',
      name: 'yt-dlp',
      detail: `${m.own} 2026.08.19, older than the pinned 2026.10.26; update it: ${YTDLP_INSTALL_COMMAND}`,
    });
    expect(lines.slice(1)).toEqual([
      {
        ok: 'warn',
        name: 'yt-dlp (not used)',
        detail: `${join(m.pathBin, 'yt-dlp')}: the runner uses only ${m.own}; remove this copy if nothing else needs it`,
      },
    ]);
  });

  it('is ok at the pin; without the toolchains copy it warns with the command and never runs the PATH copy', async () => {
    const ok = machine(true);
    const atPin = await ytDlpDoctorLines({
      home: ok.home,
      processHome: ok.home,
      pathEnv: '',
      exists: existsSync,
      version: async () => '2026.10.26',
      pin: '2026.10.26',
    });
    expect(atPin).toEqual([{ ok: true, name: 'yt-dlp', detail: `${ok.own} 2026.10.26` }]);

    const m = machine(false);
    const ran: string[] = [];
    const lines = await ytDlpDoctorLines({
      home: m.home,
      processHome: m.home,
      pathEnv: m.pathBin,
      exists: existsSync,
      version: async (bin) => {
        ran.push(bin);
        return '2026.10.26';
      },
      pin: '2026.10.26',
    });
    expect(ran).toEqual([]);
    expect(lines[0]?.ok).toBe('warn');
    expect(lines[0]?.detail).toContain(YTDLP_INSTALL_COMMAND);
    expect(lines.map((l) => l.name)).toEqual(['yt-dlp', 'yt-dlp (not used)']);
  });

  it('names leftover copies in Homebrew, /usr/local/bin and the person’s ~/.local/bin', async () => {
    const home = '/home/runner';
    const lines = await ytDlpDoctorLines({
      home,
      processHome: '/home/alice',
      pathEnv: '/usr/bin',
      exists: (p) =>
        ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/home/alice/.local/bin/yt-dlp'].includes(p),
      version: async () => null,
      pin: '2026.10.26',
    });
    expect(lines.filter((l) => l.name === 'yt-dlp (not used)').map((l) => l.detail.split(':')[0])).toEqual([
      '/opt/homebrew/bin/yt-dlp',
      '/usr/local/bin/yt-dlp',
      '/home/alice/.local/bin/yt-dlp',
    ]);
  });

  it('compares yt-dlp date versions', () => {
    expect(compareYtDlpVersions('2026.08.19', '2026.10.26')).toBe(-1);
    expect(compareYtDlpVersions('2026.10.26.1', '2026.10.26')).toBe(1);
    expect(compareYtDlpVersions('2026.10.26', '2026.10.26')).toBe(0);
    expect(compareYtDlpVersions('nightly', '2026.10.26')).toBe(0);
  });
});
