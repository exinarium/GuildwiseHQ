/**
 * Optional extras the runner installs for itself (DESIGN easy-runner-setup, `[S5]`). Today one: yt-dlp, which
 * `aom transcript` uses for YouTube and other video sites.
 *
 * For setup (the "Video transcripts" item) and the CLI:
 *
 *   installExtra(id: ExtraId, deps?: InstallExtraDeps): Promise<{ ok: boolean; detail: string }>
 *
 *   - `id`: `'yt-dlp'` (see {@link EXTRAS}).
 *   - `deps.log`: progress lines (default: none). `deps.install`: test overrides of the user-install machinery.
 *   - Never throws. `ok: false` with a one-line `detail` when it refuses (root, a foreign `$HOME`, no pinned build for
 *     this platform, a checksum mismatch) or the download fails.
 *
 * yt-dlp is installed as the runner user only, into the toolchains root of the runner account's own home
 * (`<home>/.local/share/guildwise/toolchains/yt-dlp/<version>`, linked as `<root>/bin/yt-dlp`), from the pinned
 * release with the pinned sha256 (`pins.ts` `YTDLP`). It is never installed system-wide, and the runner never uses a
 * yt-dlp from PATH: {@link ytDlpPath} is the only place transcripts and the doctor look.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { execa } from 'execa';
import { YTDLP } from './pins.ts';
import type { Platform } from './types.ts';
import {
  accountHome,
  createUserInstaller,
  toolchainsRoot,
  type UserInstallDeps,
  type UserInstallPlan,
} from './user-install.ts';

/** The command a person runs, as the runner user, to install or update yt-dlp. */
export const YTDLP_INSTALL_COMMAND = 'guildwise-runner extras install yt-dlp';

export const EXTRAS = ['yt-dlp'] as const;
export type ExtraId = (typeof EXTRAS)[number];
export const isExtraId = (s: string): s is ExtraId => (EXTRAS as readonly string[]).includes(s);

/** The shape of `pins.ts` `YTDLP` (tests pass their own). */
export interface YtDlpPin {
  version: string;
  files: Partial<Record<'linux' | 'linux-arm64' | 'darwin', { file: string; sha256: string }>>;
}

/** The pinned build for this platform; `null` when there is none (Windows, other CPUs). */
export function ytDlpAsset(
  platform: Platform | string,
  arch: string,
  pin: YtDlpPin = YTDLP,
): { file: string; sha256: string } | null {
  if (platform === 'darwin') return pin.files.darwin ?? null;
  if (platform === 'linux' && arch === 'x64') return pin.files.linux ?? null;
  if (platform === 'linux' && arch === 'arm64') return pin.files['linux-arm64'] ?? null;
  return null;
}

/** The user-space install of the pinned yt-dlp (a single verified file); `null` when this platform has no build. */
export function ytDlpPlan(
  platform: Platform | string = process.platform,
  arch: string = process.arch,
  pin: YtDlpPin = YTDLP,
): UserInstallPlan | null {
  const asset = ytDlpAsset(platform, arch, pin);
  if (!asset) return null;
  return {
    archives: [
      {
        url: `https://github.com/yt-dlp/yt-dlp/releases/download/${pin.version}/${asset.file}`,
        checksum: { algo: 'sha256', hex: asset.sha256 },
        format: 'file',
        fileName: 'yt-dlp',
        tool: 'yt-dlp',
        version: pin.version,
        bins: { 'yt-dlp': 'yt-dlp' },
      },
    ],
  };
}

/** `<toolchains root>/bin/yt-dlp` when it is there (a dangling link counts as missing); never a PATH lookup. */
export function ytDlpPath(
  home: string = accountHome(),
  exists: (p: string) => boolean = existsSync,
): string | null {
  const p = ytDlpLink(home);
  return exists(p) ? p : null;
}

/** Where {@link ytDlpPath} looks: `<toolchains root>/bin/yt-dlp`. */
export const ytDlpLink = (home: string = accountHome()): string =>
  join(toolchainsRoot(home), 'bin', 'yt-dlp');

/** Installs the pinned yt-dlp through the user-install machinery (refuses root; the runner's own home only). */
export async function installYtDlp(
  deps: Partial<UserInstallDeps> = {},
  log: (l: string) => void = () => {},
  pin: YtDlpPin = YTDLP,
): Promise<{ ok: boolean; detail: string }> {
  const installer = createUserInstaller(deps);
  const r = await installer.install('yt-dlp', async (ctx) => ytDlpPlan(ctx.platform, ctx.arch, pin), {}, log);
  if (r === null)
    return {
      ok: false,
      detail: `yt-dlp: no pinned build for ${deps.platform ?? process.platform}/${deps.arch ?? process.arch}`,
    };
  return r.ok ? { ok: true, detail: `yt-dlp ${pin.version} ${r.detail}` } : { ok: false, detail: r.detail };
}

export interface InstallExtraDeps {
  log?: (line: string) => void;
  /** Overrides of the user-install machinery (tests). */
  install?: Partial<UserInstallDeps>;
}

/** What setup and `guildwise-runner extras install <id>` call. Never throws. */
export async function installExtra(
  id: ExtraId,
  deps: InstallExtraDeps = {},
): Promise<{ ok: boolean; detail: string }> {
  if (id === 'yt-dlp') return installYtDlp(deps.install ?? {}, deps.log ?? (() => {}));
  return { ok: false, detail: `unknown extra ${String(id)} (known: ${EXTRAS.join(', ')})` };
}

// ------------------------------------------------------------------------------------------------- doctor

/** `2026.10.26` < `2026.10.26.1` < `2026.11.02`; anything unparsable compares as equal (no warning). */
export function compareYtDlpVersions(a: string, b: string): number {
  const pa = a.trim().split('.').map(Number);
  const pb = b.trim().split('.').map(Number);
  if ([...pa, ...pb].some((n) => !Number.isFinite(n))) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface DoctorLine {
  ok: boolean | 'warn';
  name: string;
  detail: string;
}

export interface YtDlpDoctorDeps {
  /** The runner account's home (password database). */
  home: string;
  /** The process's `$HOME` (whose `~/.local/bin` an old installer used). */
  processHome: string;
  /** The PATH to search for leftover copies. */
  pathEnv: string;
  exists(p: string): boolean;
  /** Runs `<bin> --version`. */
  version(bin: string): Promise<string | null>;
  pin: string;
}

const defaultDoctorDeps = (): YtDlpDoctorDeps => ({
  home: accountHome(),
  processHome: homedir(),
  pathEnv: process.env.PATH ?? '',
  exists: existsSync,
  version: async (bin) => {
    const r = await execa(bin, ['--version'], { reject: false, stdin: 'ignore', timeout: 10_000 }).catch(
      () => undefined,
    );
    return r && r.exitCode === 0 ? String(r.stdout).trim() : null;
  },
  pin: YTDLP.version,
});

/**
 * The doctor's yt-dlp lines: the toolchains copy it uses (with its version, and a warning with the command when it is
 * older than the pin), then every other copy it finds on PATH or in the usual places (Homebrew, `/usr/local/bin`, a
 * `~/.local/bin`) named as "not used".
 */
export async function ytDlpDoctorLines(over: Partial<YtDlpDoctorDeps> = {}): Promise<DoctorLine[]> {
  const d = { ...defaultDoctorDeps(), ...over };
  const lines: DoctorLine[] = [];
  const own = ytDlpLink(d.home);
  const found = ytDlpPath(d.home, d.exists);
  if (!found)
    lines.push({
      ok: 'warn',
      name: 'yt-dlp',
      detail: `not installed in ${own} (optional: \`aom transcript\` needs it for YouTube and other video sites; install it as the runner user: ${YTDLP_INSTALL_COMMAND})`,
    });
  else {
    const v = await d.version(found);
    if (!v)
      lines.push({
        ok: 'warn',
        name: 'yt-dlp',
        detail: `${own} does not run; reinstall it: ${YTDLP_INSTALL_COMMAND}`,
      });
    else if (compareYtDlpVersions(v, d.pin) < 0)
      lines.push({
        ok: 'warn',
        name: 'yt-dlp',
        detail: `${own} ${v}, older than the pinned ${d.pin}; update it: ${YTDLP_INSTALL_COMMAND}`,
      });
    else lines.push({ ok: true, name: 'yt-dlp', detail: `${own} ${v}` });
  }
  const dirs = [
    ...d.pathEnv.split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    join(d.processHome, '.local', 'bin'),
    join(d.home, '.local', 'bin'),
  ];
  const ownBin = resolve(toolchainsRoot(d.home), 'bin');
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir) continue;
    const abs = resolve(dir);
    if (abs === ownBin || seen.has(abs)) continue;
    seen.add(abs);
    const p = join(abs, 'yt-dlp');
    if (d.exists(p))
      lines.push({
        ok: 'warn',
        name: 'yt-dlp (not used)',
        detail: `${p}: the runner uses only ${own}; remove this copy if nothing else needs it`,
      });
  }
  return lines;
}
