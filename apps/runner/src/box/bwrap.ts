import { spawnSync } from 'node:child_process';

/**
 * quiet-approvals phase B: the bubblewrap the runner builds both DevOps boxes with (D7 (b)). The runner starts the outer
 * box and the inner box itself, never one inside the other, so neither needs a user namespace inside it.
 *
 * Round 6 nit: `--bind-fd`/`--ro-bind-fd` (the R5-B1 folder binds) need bubblewrap 0.8.0 or newer. An older or missing
 * bubblewrap holds DevOps and CEO work (fail closed); the DevBox has 0.11.1.
 */

export const BWRAP_MIN_VERSION = '0.8.0';

const parts = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);

export function versionAtLeast(have: string, want: string): boolean {
  const h = parts(have);
  const w = parts(want);
  for (let i = 0; i < Math.max(h.length, w.length); i++) {
    const a = h[i] ?? 0;
    const b = w[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export interface BwrapProbe {
  ok: boolean;
  reason: string;
  version?: string;
}

/** Is the installed bubblewrap new enough for the boxes (version and the fd binds)? `run` is a test hook. */
export function probeBwrap(
  bin = 'bwrap',
  run: (args: string[]) => { status: number | null; stdout: string } = (args) => {
    const r = spawnSync(bin, args, { encoding: 'utf8' });
    return { status: r.status, stdout: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  },
): BwrapProbe {
  const v = run(['--version']);
  if (v.status !== 0) return { ok: false, reason: 'bubblewrap is not installed (apt install bubblewrap)' };
  const version = /(\d+\.\d+(?:\.\d+)?)/.exec(v.stdout)?.[1];
  if (!version) return { ok: false, reason: `bubblewrap says "${v.stdout.trim().slice(0, 80)}"` };
  if (!versionAtLeast(version, BWRAP_MIN_VERSION))
    return {
      ok: false,
      version,
      reason: `bubblewrap ${version} is too old for the DevOps safety box: it needs ${BWRAP_MIN_VERSION} or newer (Ubuntu 24.04 and newer have it; on Ubuntu 22.04 install a newer bubblewrap, or move the runner to a newer system)`,
    };
  const help = run(['--help']);
  if (!/--bind-fd/.test(help.stdout) || !/--disable-userns/.test(help.stdout))
    return { ok: false, version, reason: `bubblewrap ${version} lacks --bind-fd or --disable-userns` };
  return { ok: true, version, reason: `bubblewrap ${version}` };
}
