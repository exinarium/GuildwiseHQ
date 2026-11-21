import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ReleasePreparePayload } from '@aom/shared';
import { stripDeployEnv } from '../policy/deploy-pin.ts';

/**
 * `release.prepare` (R30, W14 contract): package the runner of a shipped release for one deploy target with that target's
 * PUBLIC key, in a clean worktree of this workstation's clone at the release commit:
 *   bash scripts/package-runner.sh --pubkey <target.pub> --out <worktree>/<dir of artefact>
 * The package step is repository code that runs outside the sandbox, so the command is a held item (local yes). The
 * worktree stays: the tgz and the manifest stay on this workstation, and `release.sign` signs exactly that manifest.
 */

export const RELEASE_PREP_DIR = 'release-prep';

export type PrepareExec = (
  cmd: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ code: number | null; output: string }>;

const realExec: PrepareExec = (cmd, args, o) =>
  new Promise((done) => {
    const p = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const add = (d: Buffer) => {
      output = (output + String(d)).slice(-8000);
    };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    const t = setTimeout(() => p.kill('SIGKILL'), o.timeoutMs);
    p.on('error', (err) => {
      clearTimeout(t);
      done({ code: null, output: String(err) });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      done({ code, output });
    });
  });

/** A path inside `root` (after resolving links of what exists), or null. */
export function insideRoot(root: string, path: string): string | null {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const r = real(root);
  const p = real(path);
  return p === r || p.startsWith(r + sep) ? p : null;
}

/** The artefact path of the payload: relative, no `..`, inside the worktree. */
export function artefactInWorktree(worktree: string, artefact: string): string | null {
  if (isAbsolute(artefact) || artefact.split(/[\\/]+/).some((s) => s === '..' || s === '')) return null;
  const abs = resolve(worktree, artefact);
  return relative(worktree, abs).startsWith('..') ? null : abs;
}

export async function prepareRelease(o: {
  payload: ReleasePreparePayload;
  repoPath: string;
  /** `<data dir>/release-prep`: every prepared artefact lives under it (release.sign signs nothing else). */
  workRoot: string;
  git: (cwd: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  exec?: PrepareExec;
}): Promise<{ artefactPath: string; manifest: string; sha256: string }> {
  const p = o.payload;
  const dir = join(o.workRoot, `${p.releaseId}-${p.targetId}`);
  const artefactPath = artefactInWorktree(dir, p.artefact);
  if (!artefactPath) throw new Error(`the artefact path ${p.artefact} is not a path inside the repository`);
  mkdirSync(o.workRoot, { recursive: true, mode: 0o700 });
  if (existsSync(dir)) {
    await o.git(o.repoPath, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
    await o.git(o.repoPath, ['worktree', 'prune']);
  }
  if ((await o.git(o.repoPath, ['cat-file', '-e', `${p.commit}^{commit}`])).exitCode !== 0)
    await o.git(o.repoPath, ['fetch', 'origin']);
  const add = await o.git(o.repoPath, ['worktree', 'add', '--detach', dir, p.commit]);
  if (add.exitCode !== 0)
    throw new Error(`could not check out ${p.commit.slice(0, 12)}: ${add.stderr.trim().slice(0, 300)}`);
  const script = join(dir, 'scripts', 'package-runner.sh');
  if (!existsSync(script))
    throw new Error('the release has no scripts/package-runner.sh: nothing to package');
  const pub = `${dir}.pub`;
  writeFileSync(pub, `untrusted comment: minisign public key ${p.keyId}\n${p.publicKey}\n`, { mode: 0o644 });
  const out = dirname(artefactPath);
  const r = await (o.exec ?? realExec)('bash', [script, '--pubkey', pub, '--out', out], {
    cwd: dir,
    env: stripDeployEnv(process.env, process.env.PATH),
    timeoutMs: 45 * 60_000,
  });
  if (r.code !== 0)
    throw new Error(`the package step failed (exit ${r.code ?? 'none'}): ${r.output.trim().slice(-500)}`);
  if (!existsSync(artefactPath)) throw new Error(`the package step wrote no ${p.artefact}`);
  const manifest = readFileSync(artefactPath, 'utf8');
  let version: unknown;
  try {
    version = (JSON.parse(manifest) as { version?: unknown }).version;
  } catch {
    throw new Error(`${p.artefact} is not a release manifest`);
  }
  if (version !== p.version) throw new Error(`the package step built ${String(version)}, not ${p.version}`);
  return { artefactPath, manifest, sha256: createHash('sha256').update(manifest).digest('hex') };
}
