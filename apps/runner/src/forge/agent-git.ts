import {
  CONNECTABLE_FORGES,
  type ConnectableForge,
  connectSteps,
  defaultHost,
  FORGE_LABELS,
  type IpcRpcResponse,
} from '@aom/shared';
import { execa } from 'execa';
import { redact } from '../secrets/redact.ts';
import type { Executor } from '../toolchain/exec.ts';
import { describeConnection, touchRecheck } from './connect.ts';
import { gitConnections } from './index.ts';
import type { ForgeEnv } from './types.ts';

/** A browser or device-code login that keeps running after we answered (the user finishes it in their browser). */
export interface LoginProcess {
  /** Everything printed so far (stdout and stderr). */
  output(): string;
  /** Calls back on every chunk. */
  onOutput(cb: () => void): void;
  /** The exit code when it ends. */
  done: Promise<number>;
  kill(): void;
}
export type LoginSpawner = (cmd: string, args: string[]) => LoginProcess;

/** The real thing: no stdin (a prompt can never be typed into), a hard time limit, output redacted by the caller. */
export const spawnLogin: LoginSpawner = (cmd, args) => {
  let out = '';
  const cbs: Array<() => void> = [];
  const child = execa(cmd, args, {
    reject: false,
    stdin: 'ignore',
    timeout: 10 * 60_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const feed = (b: Buffer | string) => {
    out += String(b);
    for (const cb of cbs) cb();
  };
  child.stdout?.on('data', feed);
  child.stderr?.on('data', feed);
  return {
    output: () => out,
    onOutput: (cb) => void cbs.push(cb),
    done: child.then((r) => (typeof r.exitCode === 'number' ? r.exitCode : 1)),
    kill: () => void child.kill(),
  };
};

export interface AgentGitDeps {
  env: ForgeEnv;
  /** The runner's secrets dir: where the "report the new git status" marker is touched. */
  secretsDir: string;
  spawn?: LoginSpawner;
  /** How long to wait for the sign-in URL or code to appear before answering. Default 20 s. */
  waitMs?: number;
}

const isProvider = (p: unknown): p is ConnectableForge =>
  typeof p === 'string' && (CONNECTABLE_FORGES as readonly string[]).includes(p);

const hostOk = (h: unknown): h is string => typeof h === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,198}$/.test(h);

/**
 * `aom git status` and `aom git connect <provider>` for the DevOps engineer. The runner drives the login on this
 * workstation (the same as `aom-runner git-connect`), the agent only relays what the user must do:
 *
 * - a browser or device-code login prints a URL and a code: the agent shows them to the user, who finishes it in their
 *   browser. The login keeps running here and the status refreshes by itself (`aom git status` shows it).
 * - a login that needs a secret (a token) is never started: the agent cannot type a secret, so it tells the user to
 *   run `aom-runner git-connect <provider>` in a terminal, or use the app's Connect helper (Workstations, git hosts).
 *
 * Nothing here takes, prints or stores a secret.
 */
export class AgentGit {
  private readonly pending = new Map<string, LoginProcess>();

  constructor(private readonly deps: AgentGitDeps) {}

  async handle(method: string, params: Record<string, unknown>): Promise<IpcRpcResponse> {
    try {
      if (method === 'git.status') return await this.status(params);
      if (method === 'git.connect') return await this.connect(params);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: false, error: `${method} is not available` };
  }

  private async lines(provider?: ConnectableForge, host?: string): Promise<string[]> {
    const hosts = provider && host ? { [provider]: [host] } : {};
    const all = await gitConnections(this.deps.env, hosts);
    return all.filter((c) => !provider || c.provider === provider).map(describeConnection);
  }

  private async status(params: Record<string, unknown>): Promise<IpcRpcResponse> {
    const provider = params.provider;
    if (provider !== undefined && !isProvider(provider))
      return { ok: false, error: `unknown provider: use one of ${CONNECTABLE_FORGES.join(', ')}` };
    const host = hostOk(params.host) ? params.host : undefined;
    const lines = await this.lines(provider, host);
    const waiting = [...this.pending.keys()].map((k) => `A sign-in for ${k} is waiting for the user.`);
    return { ok: true, result: { message: [...lines, ...waiting].join('\n') } };
  }

  private needsSecret(provider: ConnectableForge, host: string, why: string): IpcRpcResponse {
    return {
      ok: true,
      result: {
        state: 'needs_secret',
        message: [
          `${FORGE_LABELS[provider]} needs a secret (${why}). Do not ask for it in this chat and do not type one yourself.`,
          'Tell the user to do ONE of these:',
          `- in a terminal on this workstation, run: aom-runner git-connect ${provider}${host !== defaultHost(provider) ? ` --host ${host}` : ''}  (it asks for the token and keeps it on this machine);`,
          "- or open Workstations in the app and use the Connect helper for this git host.",
          'The steps for the user:',
          ...connectSteps(provider, host),
          `When they say it is done, check with: aom git status ${provider}`,
        ].join('\n'),
      },
    };
  }

  private async has(cmd: string, args: string[] = ['--version']): Promise<boolean> {
    const ex: Executor = this.deps.env.exec;
    return (await ex.run(cmd, args, { timeoutMs: 15_000 })).exitCode === 0;
  }

  private async connect(params: Record<string, unknown>): Promise<IpcRpcResponse> {
    const provider = params.provider;
    if (!isProvider(provider))
      return { ok: false, error: `usage: aom git connect <${CONNECTABLE_FORGES.join('|')}> [--host <host>]` };
    if (params.host !== undefined && !hostOk(params.host)) return { ok: false, error: 'invalid --host' };
    const host = (params.host as string | undefined) ?? defaultHost(provider);
    const label = FORGE_LABELS[provider];

    const now = await this.lines(provider, host);
    const connected = (await gitConnections(this.deps.env, { [provider]: [host] })).find(
      (c) => c.provider === provider && c.host === host && c.state === 'connected',
    );
    if (connected)
      return { ok: true, result: { state: 'connected', message: `Already connected. ${now.join('\n')}` } };

    const key = `${provider}@${host}`;
    if (this.pending.has(key))
      return {
        ok: true,
        result: {
          state: 'waiting_for_user',
          message: `A sign-in for ${label} is already waiting for the user. Ask them to finish it in the browser, then check: aom git status ${provider}`,
        },
      };

    const bin = this.deps.env;
    let login: { cmd: string; args: string[]; after?: () => Promise<void> } | null = null;
    if (provider === 'github') {
      const gh = bin.ghBin ?? 'gh';
      if (!(await this.has(gh)))
        return {
          ok: true,
          result: {
            state: 'unavailable',
            message:
              'The GitHub CLI (gh) is not installed on this workstation. Install it (https://cli.github.com), then run this again.',
          },
        };
      login = {
        cmd: gh,
        args: ['auth', 'login', '--web', '--hostname', host, '--git-protocol', 'https'],
        after: async () => void (await bin.exec.run(gh, ['auth', 'setup-git', '--hostname', host])),
      };
    } else if (provider === 'gitlab') {
      const glab = bin.glabBin ?? 'glab';
      if (!(await this.has(glab))) return this.needsSecret(provider, host, 'the GitLab CLI (glab) is not installed');
      login = { cmd: glab, args: ['auth', 'login', '--hostname', host, '--web'] };
    } else if (provider === 'azure-devops') {
      const az = bin.azBin ?? 'az';
      if (!(await this.has(az)))
        return this.needsSecret(
          provider,
          host,
          'the Azure CLI (az) is not installed and no Microsoft Entra service principal is set',
        );
      login = { cmd: az, args: ['login', '--use-device-code'] };
    } else return this.needsSecret(provider, host, 'Bitbucket Cloud only signs in with an API token');

    const proc = (this.deps.spawn ?? spawnLogin)(login.cmd, login.args);
    this.pending.set(key, proc);
    const after = login.after;
    void proc.done
      .then(async (code) => {
        if (code === 0) await after?.();
      })
      .catch(() => undefined)
      .finally(() => {
        this.pending.delete(key);
        touchRecheck(this.deps.secretsDir);
      });

    const shown = await this.waitForPrompt(proc);
    if (shown === 'exited') {
      const code = await proc.done;
      const text = redact(proc.output()).trim().slice(-1500);
      return code === 0
        ? { ok: true, result: { state: 'connected', message: `${text}\n${(await this.lines(provider, host)).join('\n')}`.trim() } }
        : { ok: true, result: { state: 'failed', message: `The ${label} sign-in did not start (exit ${code}).\n${text}` } };
    }
    const text = redact(proc.output()).trim().slice(-1500);
    return {
      ok: true,
      result: {
        state: 'waiting_for_user',
        message: [
          `The ${label} sign-in is waiting for the user. Show them this, exactly, and ask them to finish it in their browser:`,
          text || '(no URL printed yet: run `aom git status` in a moment, or ask the user to run `aom-runner git-connect ' + provider + '`)',
          `When they say it is done, check with: aom git status ${provider}`,
        ].join('\n'),
      },
    };
  }

  /** Waits until a URL (and, if it comes, a code) was printed, the process ended, or the time is up. */
  private waitForPrompt(proc: LoginProcess): Promise<'prompt' | 'exited' | 'timeout'> {
    const limit = this.deps.waitMs ?? 20_000;
    return new Promise((resolve) => {
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const fin = (r: 'prompt' | 'exited' | 'timeout') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        resolve(r);
      };
      const timer = setTimeout(() => fin('timeout'), limit);
      void proc.done.then(() => fin('exited'));
      const check = () => {
        const o = proc.output();
        if (/https?:\/\/\S+/.test(o) && !grace) grace = setTimeout(() => fin('prompt'), 800);
      };
      proc.onOutput(check);
      check();
    });
  }
}
