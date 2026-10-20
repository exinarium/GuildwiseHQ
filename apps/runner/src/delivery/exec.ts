import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type DeployExecPayload,
  type DeployExecResult,
  expandTemplate,
  parseRecipe,
  RECIPE_FILE,
  type RecipeEnv,
  type RecipeTemplateVar,
} from '@aom/shared';
import { git } from '../git/git.ts';
import { type Logger, nullLogger } from '../log.ts';
import type { RunnerPaths } from '../paths.ts';
import { probeHttp, probeTcp } from '../runs/health.ts';
import { signalGroup } from '../runs/proc.ts';
import { redact, registerSecret } from '../secrets/redact.ts';
import {
  type Bundle,
  BundleError,
  exportBundle,
  hasCommit,
  readBundleAtCommit,
  readBundleFromDir,
} from './bundle.ts';

/**
 * Runs an approved deploy (docs/design/ceo-front-door.md 9.5). Everything here is deterministic code: no model, no prompt.
 * Steps: re-check the content hash of what was exported from the vault, resolve the secrets by NAME, prepare a clean
 * checkout, run the script in its own process group with a deadline, then the health check and the smoke script. The log
 * is redacted. Whatever happens is an ANSWER (`outcome`), never an exception: the server never retries a deploy blindly.
 */

export interface DeployVaults {
  exclusive<T>(vaultId: string, fn: (dir: string) => Promise<T>): Promise<T>;
  syncNow(vaultId: string): Promise<unknown>;
}

export interface DeployExecDeps {
  paths: RunnerPaths;
  vaults: DeployVaults;
  secrets: {
    valuesFor(
      projectId: string,
      wanted: readonly string[],
    ): { values: Record<string, string>; missing: string[] };
  };
  findRepo(remoteUrlNormalized: string): Promise<{ localPath: string } | undefined>;
  send(
    type: 'deploy.progress',
    payload: { runId: string; phase: 'started' | 'health' | 'smoke'; detail?: string },
  ): void;
  log?: Logger;
  now?: () => Date;
  /** Environment the scripts inherit (default: the runner's own, which is the user's). */
  baseEnv?: NodeJS.ProcessEnv;
  /** The user's home directory for `~/` in an env file path (tests point it at a temp folder). */
  home?: string;
  fetchImpl?: typeof fetch;
  /** Tests shorten these. */
  timing?: {
    healthPollMs?: number;
    healthTimeoutSec?: number;
    killGraceMs?: number;
    graceMs?: number;
    timeoutMs?: number;
  };
}

const TAIL = 6000;
const MAX_OUTPUT = 2_000_000;

const refused = (why: string, extra: Partial<DeployExecResult> = {}): DeployExecResult => ({
  outcome: 'refused',
  refused: why,
  logTail: '',
  durationMs: 0,
  summary: `refused: ${why}`,
  ...extra,
});

/** `KEY=value` lines (an optional `export `, optional quotes), as a dotenv file the owner keeps for the script. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trim().startsWith('#')) continue;
    let v = m[2] as string;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1] as string] = v;
  }
  return out;
}

const expandHome = (p: string, home: string = homedir()): string =>
  p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p;

export class DeployExecutor {
  private readonly log: Logger;
  private readonly inflight = new Map<string, Promise<DeployExecResult>>();

  constructor(private readonly deps: DeployExecDeps) {
    this.log = deps.log ?? nullLogger;
  }

  private dir(runId: string): string {
    return join(this.deps.paths.root, 'deploys', runId);
  }

  /** `deploy.exec`. A command delivered twice (a reconnect) answers once: the second waits for, or reads, the first's result. */
  run(p: DeployExecPayload): Promise<DeployExecResult> {
    const prior = this.inflight.get(p.runId);
    if (prior) return prior;
    const result = join(this.dir(p.runId), 'result.json');
    if (existsSync(result)) {
      try {
        return Promise.resolve(JSON.parse(readFileSync(result, 'utf8')) as DeployExecResult);
      } catch {
        // unreadable: run again would deploy twice, so say so
        return Promise.resolve({
          outcome: 'failed',
          logTail: '',
          durationMs: 0,
          summary: 'this deploy ran before; its result file is unreadable',
        });
      }
    }
    const t = this.execute(p)
      .catch(
        (err): DeployExecResult => ({
          outcome: 'failed',
          logTail: '',
          durationMs: 0,
          summary: `the deploy runner failed: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            500,
          ),
        }),
      )
      .then((r) => {
        try {
          mkdirSync(this.dir(p.runId), { recursive: true });
          writeFileSync(result, JSON.stringify(r), { mode: 0o600 });
        } catch {
          // the answer still goes to the server
        }
        return r;
      })
      .finally(() => this.inflight.delete(p.runId));
    this.inflight.set(p.runId, t);
    return t;
  }

  private async loadBundle(p: DeployExecPayload): Promise<Bundle> {
    const read = () =>
      this.deps.vaults.exclusive(p.vault.vaultId, async (dir) => {
        if (p.vault.storage === 'local')
          return readBundleFromDir(join(dir, ...p.vault.folder.split('/'), 'delivery'));
        if (!p.vaultCommit) throw new BundleError('no_commit', 'the approval names no vault commit');
        return readBundleAtCommit(dir, p.vault.folder, p.vaultCommit);
      });
    try {
      return await read();
    } catch (err) {
      // The approved commit may be on another workstation's push: pull, then look again once.
      if (err instanceof BundleError && err.code === 'no_commit' && p.vault.storage === 'git') {
        await this.deps.vaults.syncNow(p.vault.vaultId).catch(() => undefined);
        return read();
      }
      throw err;
    }
  }

  private secretsFor(
    p: DeployExecPayload,
    env: RecipeEnv,
  ): { values: Record<string, string> } | { missing: string } {
    if (env.secrets.length === 0) return { values: {} };
    const stored = this.deps.secrets.valuesFor(p.projectId, env.secrets);
    const values = { ...stored.values };
    const missing = stored.missing.filter((n) => values[n] === undefined);
    if (missing.length && env.envFile) {
      try {
        const file = parseEnvFile(readFileSync(expandHome(env.envFile, this.deps.home), 'utf8'));
        for (const n of missing) if (file[n] !== undefined && file[n] !== '') values[n] = file[n] as string;
      } catch {
        // no env file: the names stay missing
      }
    }
    const still = env.secrets.find((n) => values[n] === undefined);
    if (still) return { missing: still };
    for (const v of Object.values(values)) registerSecret(v);
    return { values };
  }

  private async prepareCheckout(
    p: DeployExecPayload,
    dest: string,
  ): Promise<{ path: string; commit: string; cleanup: () => Promise<void> } | { refused: string }> {
    if (!p.repo) return { refused: 'no_checkout' };
    const repo = await this.deps.findRepo(p.repo.remoteUrlNormalized);
    if (!repo) return { refused: 'no_checkout' };
    let commit = p.commit;
    if (!commit || !(await hasCommit(repo.localPath, commit))) {
      const branch = p.repo.workingBranch;
      await git(repo.localPath, branch ? ['fetch', 'origin', branch] : ['fetch', 'origin'], {
        timeoutMs: 120_000,
      });
      if (!commit && branch) {
        const r = await git(repo.localPath, ['rev-parse', `origin/${branch}`]);
        commit = r.exitCode === 0 ? r.stdout.trim() : null;
      }
      if (!commit || !(await hasCommit(repo.localPath, commit))) return { refused: 'commit_unavailable' };
    }
    rmSync(dest, { recursive: true, force: true });
    const add = await git(repo.localPath, ['worktree', 'add', '--detach', dest, commit]);
    if (add.exitCode !== 0) return { refused: 'no_checkout' };
    return {
      path: dest,
      commit,
      cleanup: async () => {
        await git(repo.localPath, ['worktree', 'remove', '--force', dest]);
        rmSync(dest, { recursive: true, force: true });
      },
    };
  }

  private async execute(p: DeployExecPayload): Promise<DeployExecResult> {
    const t0 = Date.now();
    const now = this.deps.now?.() ?? new Date();
    if (Date.parse(p.expiresAt) < now.getTime()) return refused('expired');
    const work = this.dir(p.runId);
    mkdirSync(work, { recursive: true, mode: 0o700 });

    // 1. what the Owner approved, re-read from the vault and hashed HERE
    let bundle: Bundle;
    try {
      bundle = await this.loadBundle(p);
    } catch (err) {
      if (err instanceof BundleError && err.code === 'no_commit') return refused('commit_unavailable');
      return refused('vault_unavailable', {
        summary: `refused: vault_unavailable (${err instanceof Error ? err.message : String(err)})`.slice(
          0,
          300,
        ),
      });
    }
    if (bundle.hash !== p.hash) return refused('hash_mismatch', { hash: bundle.hash });
    const recipeDir = join(work, 'recipe');
    exportBundle(bundle, recipeDir);
    const file = bundle.files.find((f) => f.path === RECIPE_FILE);
    const parsed = file ? parseRecipe(file.content.toString('utf8')) : null;
    if (!parsed?.ok) return refused('bad_recipe', { hash: bundle.hash });
    const env = parsed.recipe.environments.find((e) => e.name === p.env);
    if (!env) return refused('unknown_env', { hash: bundle.hash });
    if (!env.targets.some((t) => t.toLowerCase() === p.target.name.toLowerCase()))
      return refused('target_not_in_recipe', { hash: bundle.hash });

    // 2. secrets by name (a missing one refuses the run and names it)
    const sec = this.secretsFor(p, env);
    if ('missing' in sec) return refused(`missing_secret:${sec.missing}`, { hash: bundle.hash });

    // 3. a clean checkout of the commit
    let checkout: { path: string; commit: string; cleanup: () => Promise<void> } | undefined;
    if (p.repo) {
      const c = await this.prepareCheckout(p, join(work, 'checkout'));
      if ('refused' in c) return refused(c.refused, { hash: bundle.hash });
      checkout = c;
    }
    const commit = checkout?.commit ?? p.commit ?? '';
    const vars: Partial<Record<RecipeTemplateVar, string>> = {
      checkout: checkout?.path ?? '',
      commit,
      branch: p.repo?.workingBranch ?? '',
      env: p.env,
      appUrl: p.target.appUrl ?? '',
      target: p.target.name,
      host: p.target.host ?? '',
    };
    try {
      this.deps.send('deploy.progress', { runId: p.runId, phase: 'started' });
      const logFile = join(this.deps.paths.logs, 'deploys', `${p.runId}.log`);
      mkdirSync(join(this.deps.paths.logs, 'deploys'), { recursive: true });
      writeFileSync(
        logFile,
        `# deploy ${p.env} -> ${p.target.name} commit ${commit || '(unknown)'}${p.dryRun ? ' (dry run)' : ''}\n`,
        { mode: 0o600 },
      );
      const out = await this.runScript({
        script: join(recipeDir, env.script),
        args: env.args.map((a) => expandTemplate(a, vars)),
        cwd: checkout?.path ?? recipeDir,
        env: this.scriptEnv(p, env, vars, sec.values, commit),
        timeoutSec: env.timeoutSec,
        logFile,
      });
      const summaryBase = out.timedOut
        ? `the script did not finish within ${env.timeoutSec} s`
        : out.exitCode === 0
          ? 'the script finished'
          : `the script exited with ${out.exitCode}`;
      const done = (
        r: Partial<DeployExecResult> & { outcome: DeployExecResult['outcome'] },
      ): DeployExecResult => ({
        logTail: out.tail,
        durationMs: Date.now() - t0,
        exitCode: out.exitCode,
        hash: bundle.hash,
        deployedCommit: out.deployed?.commit ?? (commit || null),
        ...(out.deployed ? { deployed: out.deployed } : {}),
        summary: summaryBase,
        ...r,
      });
      if (out.timedOut || out.exitCode !== 0) return done({ outcome: 'failed', health: null, smoke: null });
      if (p.dryRun)
        return done({
          outcome: 'succeeded',
          summary: 'dry run: the script checked its inputs and changed nothing',
          health: null,
          smoke: null,
        });
      // 4. health, then the smoke script
      this.deps.send('deploy.progress', { runId: p.runId, phase: 'health' });
      const health = await this.checkHealth(env, vars, out.output, p.target.host);
      if (!health.ok)
        return done({
          outcome: 'failed',
          health,
          smoke: null,
          summary: `health check failed: ${health.detail ?? ''}`.slice(0, 300),
        });
      let smoke: { ok: boolean; detail?: string } | null = null;
      if (env.smoke) {
        this.deps.send('deploy.progress', { runId: p.runId, phase: 'smoke' });
        const s = await this.runScript({
          script: join(recipeDir, env.smoke),
          args: [],
          cwd: checkout?.path ?? recipeDir,
          env: this.scriptEnv(p, env, vars, sec.values, commit),
          timeoutSec: Math.min(env.timeoutSec, 900),
          logFile,
        });
        smoke = {
          ok: !s.timedOut && s.exitCode === 0,
          ...(s.exitCode === 0 ? {} : { detail: s.timedOut ? 'timed out' : `exit ${s.exitCode}` }),
        };
        if (!smoke.ok)
          return done({
            outcome: 'failed',
            health,
            smoke,
            logTail: s.tail || out.tail,
            summary: `smoke check failed (${smoke.detail})`,
          });
      }
      return done({
        outcome: 'succeeded',
        health,
        smoke,
        summary: out.deployed?.version ? `deployed ${out.deployed.version}` : 'deployed',
      });
    } finally {
      await checkout?.cleanup().catch(() => undefined);
    }
  }

  private scriptEnv(
    p: DeployExecPayload,
    env: RecipeEnv,
    vars: Partial<Record<RecipeTemplateVar, string>>,
    secrets: Record<string, string>,
    commit: string,
  ): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = {};
    // The user's own environment, minus the runner's own settings (a script gets no runner credentials).
    for (const [k, v] of Object.entries(this.deps.baseEnv ?? process.env))
      if (v !== undefined && !k.startsWith('AOM_')) base[k] = v;
    return {
      ...base,
      AOM_DEPLOY_COMMIT: commit,
      AOM_DEPLOY_CHECKOUT: vars.checkout ?? '',
      AOM_DEPLOY_ENV: p.env,
      AOM_DEPLOY_TARGET: p.target.name,
      AOM_DEPLOY_HOST: p.target.host ?? '',
      AOM_DEPLOY_APP_URL: p.target.appUrl ?? '',
      AOM_DEPLOY_DRY_RUN: p.dryRun ? '1' : '0',
      ...(env.envFile ? { AOM_DEPLOY_ENV_FILE: expandHome(env.envFile, this.deps.home) } : {}),
      ...secrets,
    };
  }

  private runScript(o: {
    script: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutSec: number;
    logFile: string;
  }): Promise<{
    exitCode: number | null;
    timedOut: boolean;
    tail: string;
    output: string;
    deployed?: NonNullable<DeployExecResult['deployed']>;
  }> {
    return new Promise((resolve) => {
      let output = '';
      let tail = '';
      let deployed: NonNullable<DeployExecResult['deployed']> | undefined;
      let timedOut = false;
      let buf = '';
      const child = spawn(o.script, o.args, {
        cwd: o.cwd,
        env: o.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const line = (raw: string): void => {
        const text = redact(raw);
        const m = /^AOM-DEPLOY\s+(\{.*\})\s*$/.exec(text);
        if (m) {
          try {
            const j = JSON.parse(m[1] as string) as Record<string, unknown>;
            deployed = {
              ...(typeof j.commit === 'string' ? { commit: j.commit.slice(0, 64) } : {}),
              ...(typeof j.url === 'string' ? { url: j.url.slice(0, 500) } : {}),
              ...(typeof j.version === 'string' ? { version: j.version.slice(0, 80) } : {}),
            };
          } catch {
            // not json: just a line
          }
        }
        if (output.length < MAX_OUTPUT) output += `${text}\n`;
        tail = `${tail}${text}\n`.slice(-TAIL);
        try {
          appendFileSync(o.logFile, `${text}\n`);
        } catch {
          // the log is best effort
        }
      };
      const feed = (chunk: Buffer): void => {
        buf += chunk.toString('utf8');
        let i = buf.indexOf('\n');
        while (i >= 0) {
          line(buf.slice(0, i).replace(/\r$/, ''));
          buf = buf.slice(i + 1);
          i = buf.indexOf('\n');
        }
        if (buf.length > 64_000) {
          line(buf);
          buf = '';
        }
      };
      child.stdout?.on('data', feed);
      child.stderr?.on('data', feed);
      const killer = setTimeout(
        () => {
          timedOut = true;
          if (child.pid) signalGroup(child.pid, 'SIGTERM');
          setTimeout(
            () => child.pid && signalGroup(child.pid, 'SIGKILL'),
            this.deps.timing?.killGraceMs ?? 10_000,
          ).unref?.();
        },
        this.deps.timing?.timeoutMs ?? o.timeoutSec * 1000,
      );
      const end = (exitCode: number | null): void => {
        clearTimeout(killer);
        if (buf) line(buf);
        buf = '';
        resolve({ exitCode, timedOut, tail, output, ...(deployed ? { deployed } : {}) });
      };
      child.once('error', (err) => {
        line(`could not start ${o.script}: ${err.message}`);
        end(127);
      });
      child.once('close', (code) => end(code));
    });
  }

  private async checkHealth(
    env: RecipeEnv,
    vars: Partial<Record<RecipeTemplateVar, string>>,
    output: string,
    host: string | null,
  ): Promise<{ ok: boolean; detail?: string }> {
    const h = env.health;
    const poll = this.deps.timing?.healthPollMs ?? 2000;
    const budgetMs = (this.deps.timing?.healthTimeoutSec ?? 120) * 1000;
    if (h.kind === 'none') {
      await new Promise((r) => setTimeout(r, this.deps.timing?.graceMs ?? Math.min(h.graceSec, 300) * 1000));
      return { ok: true };
    }
    if (h.kind === 'log') {
      let re: RegExp;
      try {
        re = new RegExp(h.regex, 'm');
      } catch {
        return { ok: false, detail: 'the log health pattern is not a valid regular expression' };
      }
      return re.test(output) ? { ok: true } : { ok: false, detail: `the output never showed ${h.regex}` };
    }
    const deadline = Date.now() + budgetMs;
    let last: { ok: boolean; detail?: string } = { ok: false };
    for (;;) {
      last =
        h.kind === 'http'
          ? await probeHttp(expandTemplate(h.url, vars), h.expect, this.deps.fetchImpl)
          : await probeTcp(h.port as number, host && host !== 'localhost' ? host : '127.0.0.1');
      if (last.ok || Date.now() >= deadline) return last;
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}
