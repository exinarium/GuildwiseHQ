import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * The on-disk layout the installer creates (and `scripts/package-runner.sh` packs), identical for fresh installs and
 * upgrades from 0.1.0:
 *
 *   <root>/                       ~/.local/share/guildwise/runner
 *     <version>/aom-runner/       one unpacked release (the tarball's top folder), with `.sha256` beside it
 *     current  -> <version>/aom-runner     what the service starts
 *     previous -> <version>/aom-runner     what to go back to (rollback)
 *     update-pending              key=value: from, to, deadline (epoch seconds) while a new version is on probation
 *     update-failed               key=value: version, at, reason of the last update that was rolled back
 *     service-mode                systemd | launchd | background (written by the installer; guessed when missing)
 *     start-runner.sh             the background fallback (no service manager)
 *
 * The marker files are plain key=value text so the shell launcher can read them without a JSON parser.
 */
export interface InstallLayout {
  root: string;
  /** The folder this process runs from: `<root>/<version>/aom-runner`. */
  packageDir: string;
  current: string;
  previous: string;
  pendingFile: string;
  failedFile: string;
  modeFile: string;
  fallbackLauncher: string;
  versionDir(version: string): string;
}

export function layoutFor(root: string, packageDir: string): InstallLayout {
  return {
    root,
    packageDir,
    current: join(root, 'current'),
    previous: join(root, 'previous'),
    pendingFile: join(root, 'update-pending'),
    failedFile: join(root, 'update-failed'),
    modeFile: join(root, 'service-mode'),
    fallbackLauncher: join(root, 'start-runner.sh'),
    versionDir: (v) => join(root, v),
  };
}

/**
 * Works out the layout from the running entry file (`process.argv[1]`, i.e. `<pkg>/dist/aom-runner.mjs`). Returns null
 * unless this process really runs from `<root>/<version>/aom-runner` and `<root>/current` points at it: a checkout, a
 * hand-copied folder or a runner that is not the one the service starts never updates itself.
 */
export function detectLayout(entryFile: string | undefined): InstallLayout | null {
  if (!entryFile) return null;
  try {
    const real = realpathSync(entryFile);
    const packageDir = dirname(dirname(real));
    if (basename(packageDir) !== 'aom-runner') return null;
    const root = dirname(dirname(packageDir));
    const layout = layoutFor(root, packageDir);
    if (!lstatSync(layout.current).isSymbolicLink()) return null;
    if (realpathSync(layout.current) !== packageDir) return null;
    return layout;
  } catch {
    return null;
  }
}

export function readKeyValues(file: string): Record<string, string> | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function writeKeyValues(file: string, values: Record<string, string | number>): void {
  const text = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(file, `${text}\n`);
}

export interface PendingUpdate {
  from: string;
  to: string;
  /** Epoch seconds: if the new version has not connected by then it is rolled back. */
  deadline: number;
}

export function readPending(layout: InstallLayout): PendingUpdate | null {
  const kv = readKeyValues(layout.pendingFile);
  if (!kv?.from || !kv.to || !/^\d+$/.test(kv.deadline ?? '')) return null;
  return { from: kv.from, to: kv.to, deadline: Number(kv.deadline) };
}

export function writePending(layout: InstallLayout, p: PendingUpdate): void {
  writeKeyValues(layout.pendingFile, { from: p.from, to: p.to, deadline: p.deadline });
}

export interface FailedUpdate {
  version: string;
  at: number;
  reason: string;
}

export function readFailed(layout: InstallLayout): FailedUpdate | null {
  const kv = readKeyValues(layout.failedFile);
  if (!kv?.version) return null;
  return { version: kv.version, at: Number(kv.at) || 0, reason: kv.reason ?? '' };
}

export function writeFailed(layout: InstallLayout, f: FailedUpdate): void {
  writeKeyValues(layout.failedFile, {
    version: f.version,
    at: f.at,
    reason: f.reason.replace(/\s+/g, ' ').slice(0, 200),
  });
}

export function removeFile(file: string): void {
  rmSync(file, { force: true });
}

/** Version folders under the root (everything that looks like a version and holds an unpacked runner). */
export function installedVersions(layout: InstallLayout): string[] {
  try {
    return readdirSync(layout.root).filter(
      (n) => /^\d+\.\d+\.\d+/.test(n) && existsSync(join(layout.root, n, 'aom-runner', 'dist')),
    );
  } catch {
    return [];
  }
}
