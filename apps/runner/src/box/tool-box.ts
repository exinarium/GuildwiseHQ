import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { assertNotAgentSession, checkSeal, readPolicyKey, seal } from '../policy/integrity.ts';
import { writeFileAtomic } from '../policy/store.ts';
import type { ExecOptions, ExecResult, Executor } from '../toolchain/exec.ts';
import { underRoot } from './folder-check.ts';

/**
 * quiet-approvals phase B (R4-B1 "nothing box-writable is executed outside a box"):
 *
 * 1. The tool box: `env.ensure` checks and installs, and the detection-root writes, run in a runner-built box with the
 *    toolchains root and the user-space tool folders writable, the project's clone writable for its dependency steps, a
 *    private home, and nothing private present (no runner data dir, no policy dir, no `~/.ssh`, no Claude login).
 * 2. Tree pins: the bin folders under the toolchains root are pinned by a content hash (sealed `tree-pins.json` in the
 *    policy dir), recorded when the runner itself installed there, and checked before a folder goes on any unboxed PATH; a
 *    folder whose content changed outside the runner's own installs stays off until pinned again.
 * `<root>/devops-tools` is never on an unboxed PATH.
 */

// ---------------------------------------------------------------- tree pins

const cache = new Map<string, { stamp: string; hash: string }>();

/** sha256 over a bin folder's entries (name, kind, mode, link target or content), non-recursive, cached by stat. */
export function binTreeHash(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return null;
  }
  const stamp = names
    .map((n) => {
      try {
        const s = lstatSync(join(dir, n));
        return `${n}:${s.mode}:${s.size}:${s.mtimeMs}:${s.ino}`;
      } catch {
        return `${n}:gone`;
      }
    })
    .join('|');
  const hit = cache.get(dir);
  if (hit && hit.stamp === stamp) return hit.hash;
  const h = createHash('sha256');
  for (const n of names) {
    const p = join(dir, n);
    try {
      const s = lstatSync(p);
      h.update(`${n}\0${s.mode}\0`);
      if (s.isSymbolicLink()) h.update(`link:${readlinkSync(p)}`);
      else if (s.isFile()) h.update(createHash('sha256').update(readFileSync(p)).digest('hex'));
      else h.update('dir');
      h.update('\n');
    } catch {
      h.update(`${n}\0gone\n`);
    }
  }
  const hash = h.digest('hex');
  cache.set(dir, { stamp, hash });
  return hash;
}

export const TREE_PINS_FILE = 'tree-pins.json';

export class TreePins {
  constructor(
    readonly policyDir: string,
    private readonly warn: (m: string) => void = () => {},
  ) {}

  private file(): string {
    return join(this.policyDir, TREE_PINS_FILE);
  }

  all(): Record<string, string> {
    try {
      const { check, body } = checkSeal(this.policyDir, JSON.parse(readFileSync(this.file(), 'utf8')));
      if (check !== 'ok') {
        if (check !== 'no_key')
          this.warn(`${this.file()} has a ${check} seal: every toolchain folder waits for a pin`);
        return {};
      }
      const pins = (body as { pins?: unknown })?.pins;
      return pins && typeof pins === 'object' ? (pins as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  /** Records the current content of these folders (only after the runner's own install, or the owner's yes). */
  pin(dirs: readonly string[]): void {
    assertNotAgentSession();
    const key = readPolicyKey(this.policyDir);
    if (!key) return;
    const pins = { ...this.all() };
    for (const d of dirs) {
      const h = binTreeHash(d);
      if (h) pins[d] = h;
    }
    writeFileAtomic(this.file(), `${JSON.stringify(seal(key, { pins }))}\n`, 0o600);
  }

  /** May this folder go on an unboxed PATH? Folders outside the guarded roots are not this check's business. */
  ok(dir: string, guardedRoots: readonly string[]): boolean {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return false;
    }
    if (!guardedRoots.some((r) => existsSync(r) && underRoot(real, realpathSync(r)))) return true;
    const want = this.all()[dir];
    return !!want && binTreeHash(dir) === want;
  }
}

// ---------------------------------------------------------------- the tool box

export interface ToolBoxPlan {
  /** Writable: the toolchains root and the user-space tool folders that exist (never `~/.local` as a whole). */
  writable: string[];
  /** Writable for dependency steps: the project's clones. */
  repoDirs: string[];
  /** The box's private home (caches). */
  home: string;
}

/** The user-space tool folders `env.ensure` installs into (the detection roots minus `~/.local`, which holds the runner). */
export function toolBoxWritable(home: string, toolchainsRoot: string): string[] {
  const roots = [
    '.dotnet',
    '.nvm',
    '.cargo',
    '.rustup',
    '.bun',
    '.pyenv',
    'go',
    '.sdkman',
    '.deno',
    '.volta',
  ];
  return [toolchainsRoot, ...roots.map((r) => join(home, r))].filter((p) => existsSync(p));
}

/** bubblewrap arguments of the tool box around one command (`--share-net`: installs download; nothing private present). */
export function toolBoxArgs(plan: ToolBoxPlan, cwd: string | undefined): string[] {
  const args = [
    '--unshare-all',
    '--share-net',
    '--unshare-user',
    '--disable-userns',
    '--new-session',
    '--die-with-parent',
    '--cap-drop',
    'ALL',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/etc',
    '/etc',
  ];
  for (const d of ['/bin', '/sbin', '/lib', '/lib32', '/lib64']) {
    try {
      if (lstatSync(d).isSymbolicLink()) args.push('--symlink', readlinkSync(d), d);
      else if (statSync(d).isDirectory()) args.push('--ro-bind', d, d);
    } catch {
      // not on this distribution
    }
  }
  if (existsSync('/etc/ssh')) args.push('--tmpfs', '/etc/ssh');
  const binds = [...new Set([plan.home, ...plan.writable, ...plan.repoDirs, ...(cwd ? [cwd] : [])])]
    .filter((p) => existsSync(p))
    .sort((a, b) => a.length - b.length);
  for (const p of binds) args.push('--bind', p, p);
  return args;
}

/** An executor that runs every command of `env.ensure` inside the tool box. */
export function toolBoxExecutor(base: Executor, plan: ToolBoxPlan, bwrap = 'bwrap'): Executor {
  return {
    run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
      const env = {
        ...(opts.env ?? {}),
        HOME: plan.home,
        PATH: [...plan.writable.map((w) => join(w, 'bin')), '/usr/local/bin', '/usr/bin', '/bin'].join(
          delimiter,
        ),
      };
      return base.run(bwrap, [...toolBoxArgs(plan, opts.cwd), '--', cmd, ...args], {
        ...opts,
        env,
        exactEnv: true,
      });
    },
  };
}
