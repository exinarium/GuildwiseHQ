import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.ts';

/**
 * quiet-approvals phase B, S7: conflict work without git writes in a main clone. The RUNNER makes a scratch clone in the
 * request's own folder (before any box runs there): the main clone's local branches as `refs/remotes/local/*`, its view of
 * origin as `refs/remotes/origin/*`, and the conflicted branch checked out. DevOps resolves on a `conflict/<name>-a<n>`
 * branch inside the inner box, where the clone's `.git/config` and `.git/hooks` are read-only.
 *
 * Rework 1 (REVIEW B3): after the box ran, the runner never runs git WITH the scratch as the repository (its config,
 * hooks, commondir, attributes and filters are box-controlled). It:
 * 1. refuses when the scratch's `.git` is not the inode it made, its config changed, or a `commondir`, `config.worktree`,
 *    `objects/info/alternates` or `info/attributes` appeared;
 * 2. reads the result only through upload-pack, from the main clone (the runner's own repository) with a runner-controlled
 *    git environment (no system or global config, no hooks), into quarantine refs `refs/guildwise/quarantine/<id>/*`;
 * 3. runs the guards and the checks' checkout in the main clone (a runner-made detached worktree), and creates the
 *    handover ref there itself (create-only, never forced) for T7's move.
 */

export const SCRATCH_CLONE_DIR = 'clone';

export interface ScratchClone {
  dir: string;
  /** Read-only inside the box: git reads them when it later uses the clone. */
  protectedPaths: string[];
  /** The `.git` folder the runner made (inode) and its config's hash: anything else afterwards is refused. */
  gitIno: number;
  configHash: string;
}

/** The environment of every git command the runner runs against a box-made result: nothing but its own settings. */
export const SAFE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ATTR_NOSYSTEM: '1',
};
const SAFE = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.file.allow=always',
];

const ok = async (cwd: string, args: string[]): Promise<void> => {
  const r = await git(cwd, args);
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().slice(0, 300)}`);
};

const hashFile = (p: string): string => {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex');
  } catch {
    return 'missing';
  }
};

export async function makeScratchClone(o: {
  mainRepo: string;
  requestDir: string;
  branch: string;
  identity?: { name: string; email: string } | null;
}): Promise<ScratchClone> {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(o.branch) || o.branch.includes('..'))
    throw new Error(`branch ${o.branch}`);
  const dir = join(o.requestDir, SCRATCH_CLONE_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  await ok(dir, ['init', '-q']);
  await ok(dir, [
    'fetch',
    '--quiet',
    '--no-tags',
    o.mainRepo,
    '+refs/heads/*:refs/remotes/local/*',
    '+refs/remotes/origin/*:refs/remotes/origin/*',
  ]);
  await ok(dir, ['checkout', '-q', '-b', o.branch, `refs/remotes/local/${o.branch}`]);
  if (o.identity) {
    await ok(dir, ['config', 'user.name', o.identity.name]);
    await ok(dir, ['config', 'user.email', o.identity.email]);
  }
  return {
    dir,
    protectedPaths: [join(dir, '.git', 'config'), join(dir, '.git', 'hooks')],
    gitIno: lstatSync(join(dir, '.git')).ino,
    configHash: hashFile(join(dir, '.git', 'config')),
  };
}

/** Why the scratch clone is no longer the one the runner made (null: intact). Never runs git there. */
export function scratchTampered(sc: ScratchClone): string | null {
  const g = join(sc.dir, '.git');
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(g);
  } catch {
    return 'its .git is gone';
  }
  if (!st.isDirectory() || st.isSymbolicLink() || st.ino !== sc.gitIno) return 'its .git was replaced';
  for (const f of [
    'commondir',
    'config.worktree',
    join('objects', 'info', 'alternates'),
    join('info', 'attributes'),
  ])
    if (existsSync(join(g, f))) return `a ${f} appeared in its .git`;
  if (hashFile(join(g, 'config')) !== sc.configHash) return 'its git config changed';
  return null;
}

/**
 * The scratch's resolution, read through upload-pack into the main clone's quarantine refs. Returns the candidate (the
 * conflict/* branch HEAD points at, or the only one) or why not.
 */
export async function quarantineResolution(
  mainRepo: string,
  sc: ScratchClone,
  id: string,
): Promise<{ ok: true; name: string; sha: string; ref: string } | { ok: false; reason: string }> {
  const tampered = scratchTampered(sc);
  if (tampered) return { ok: false, reason: `the scratch clone was tampered with: ${tampered}` };
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return { ok: false, reason: 'not a quarantine id' };
  const ls = await git(
    mainRepo,
    [...SAFE, 'ls-remote', '--symref', sc.dir, 'HEAD', 'refs/heads/conflict/*'],
    {
      env: { ...SAFE_GIT_ENV },
    },
  );
  if (ls.exitCode !== 0) return { ok: false, reason: 'the resolution could not be read' };
  let headRef: string | undefined;
  const refs: Array<{ ref: string; sha: string }> = [];
  for (const line of ls.stdout.split('\n')) {
    const sym = /^ref: (\S+)\tHEAD$/.exec(line);
    if (sym) headRef = sym[1];
    const m = /^([0-9a-f]{40})\t(refs\/heads\/conflict\/\S+)$/.exec(line);
    if (m) refs.push({ sha: m[1] as string, ref: m[2] as string });
  }
  const cand = refs.find((r) => r.ref === headRef) ?? (refs.length === 1 ? refs[0] : undefined);
  if (!cand) return { ok: false, reason: 'no conflict/* branch with the resolution in the scratch clone' };
  const name = cand.ref.slice('refs/heads/'.length);
  if (!/^conflict\/[A-Za-z0-9._/-]{1,200}$/.test(name) || name.includes('..'))
    return { ok: false, reason: `not a conflict branch: ${name}` };
  const q = `refs/guildwise/quarantine/${id}/${name}`;
  const f = await git(mainRepo, [...SAFE, 'fetch', '--quiet', '--no-tags', sc.dir, `+${cand.ref}:${q}`], {
    env: { ...SAFE_GIT_ENV },
  });
  if (f.exitCode !== 0) return { ok: false, reason: 'the resolution could not be fetched' };
  const sha = (await git(mainRepo, ['rev-parse', q])).stdout.trim();
  if (sha !== cand.sha) return { ok: false, reason: 'the resolution changed while it was read' };
  return { ok: true, name, sha, ref: q };
}

/** The handover ref T7 moves from, made by the runner in the main clone (create-only, never forced). */
export async function promoteHandover(mainRepo: string, name: string, sha: string): Promise<void> {
  const r = await git(mainRepo, ['update-ref', `refs/heads/${name}`, sha, ''], { env: { ...SAFE_GIT_ENV } });
  if (r.exitCode !== 0)
    throw new Error(`the resolution could not be handed over: ${r.stderr.trim().slice(0, 300)}`);
}

/** What the DevOps engineer is told about the scratch clone (from the runner, never from server text). */
export function scratchCloneNote(dir: string, branch: string): string {
  return `# Conflict work in a scratch clone

Resolve this conflict in the scratch clone at \`${dir}\` (branch \`${branch}\` is checked out there), not in a main clone or
a card worktree. Its \`origin/<branch>\` refs are this computer's view of the git host; the main clone's own branches are
\`local/<branch>\`. Create \`conflict/<name>-a<n>\` there, merge and resolve, commit, and finish with \`Resolved:\`. The runner
takes your \`conflict/*\` branch from the scratch clone and moves the real branch itself.`;
}
