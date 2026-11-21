import { createHash } from 'node:crypto';
import type { DeployExecPayload } from '@aom/shared';

/** JSON with object keys sorted at every level, so the same command always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export const sha256Hex = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/**
 * The whole-command pin of a deploy [rv4-4]: the canonical (script bundle, environment, folder and repository, target
 * settings, command kind). The bundle hash covers every file of the approved recipe: the script, its arguments, the env
 * names and non-secret values, the secret NAMES and the health and smoke settings; the runner recomputes it from the vault
 * and refuses a mismatch before anything runs. Secret values are not in it: a reseal is itself held. `commit` is in the
 * bound hash only (`deployPinCommit`) [rv4-5]. Volatile fields (run id, expiry) are left out, so a redeploy of the same
 * command matches.
 */
export function deployPinHashes(p: DeployExecPayload): { base: string; bound: string | null } {
  const core = {
    v: 1,
    kind: p.dryRun ? 'deploy.dry_run' : p.trial ? 'deploy.trial' : 'deploy.exec',
    orgId: p.orgId,
    projectId: p.projectId,
    vault: { vaultId: p.vault.vaultId },
    recipeHash: p.hash,
    env: p.env,
    target: {
      id: p.target.id,
      name: p.target.name,
      kind: p.target.kind,
      host: p.target.host,
      appUrl: p.target.appUrl,
    },
    // R30: a signed deploy builds with the target's key; a different key is a different command
    signing: p.signing ? { keyId: p.signing.keyId, publicKey: p.signing.publicKey } : null,
    repo: p.repo
      ? {
          repoId: p.repo.repoId,
          remoteUrlNormalized: p.repo.remoteUrlNormalized,
          workingBranch: p.repo.workingBranch,
        }
      : null,
  };
  const base = sha256Hex(canonicalJson({ ...core, commit: null }));
  const bound = p.commit ? sha256Hex(canonicalJson({ ...core, commit: p.commit })) : null;
  return { base, bound };
}

/**
 * Loader and interpreter variables removed from every deploy env, pinned or not (R18-S): they make an unchanged script run
 * other code. `PATH` is replaced by the runner's own.
 */
export const STRIPPED_DEPLOY_ENV = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'GIT_EXEC_PATH',
] as const;
const STRIPPED_PREFIXES = ['DYLD_', 'GIT_CONFIG_'] as const;

export function isStrippedDeployVar(name: string): boolean {
  const n = process.platform === 'win32' ? name.toUpperCase() : name;
  return (
    (STRIPPED_DEPLOY_ENV as readonly string[]).includes(n) ||
    STRIPPED_PREFIXES.some((p) => n.startsWith(p)) ||
    n === 'GIT_CONFIG'
  );
}

/** The deploy env with the loader variables removed and the runner's own PATH (applied last, after secrets). */
export function stripDeployEnv(env: NodeJS.ProcessEnv, runnerPath: string | undefined): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || isStrippedDeployVar(k)) continue;
    if (k.toUpperCase() === 'PATH') continue;
    out[k] = v;
  }
  if (runnerPath !== undefined) out.PATH = runnerPath;
  return out;
}
