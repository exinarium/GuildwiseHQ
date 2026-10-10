import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentGit, type LoginProcess } from '../src/forge/agent-git.ts';
import { MemoryTokenStore } from '../src/forge/index.ts';
import type { ForgeEnv } from '../src/forge/types.ts';
import type { ExecResult, Executor } from '../src/toolchain/exec.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();

class FakeExec implements Executor {
  calls: string[] = [];
  constructor(private readonly rules: Array<[RegExp, Partial<ExecResult>]> = []) {}
  async run(cmd: string, args: string[]): Promise<ExecResult> {
    const line = [cmd, ...args].join(' ');
    this.calls.push(line);
    for (const [re, r] of this.rules) if (re.test(line)) return { exitCode: 0, stdout: '', stderr: '', ...r };
    return { exitCode: 127, stdout: '', stderr: 'not found' };
  }
}

/** A login that prints a URL and code, then waits until the "user" finishes it. */
function fakeLogin(print: string, exit = 0) {
  const cbs: Array<() => void> = [];
  let out = '';
  let finish!: (code: number) => void;
  const done = new Promise<number>((r) => {
    finish = r;
  });
  const proc: LoginProcess = {
    output: () => out,
    onOutput: (cb) => void cbs.push(cb),
    done,
    kill: () => finish(1),
  };
  const say = () => {
    out += print;
    for (const cb of cbs) cb();
  };
  return { proc, say, finish: () => finish(exit), started: [] as string[] };
}

const mk = (exec: Executor, over: Partial<ForgeEnv> = {}) => {
  const secretsDir = mkdtempSync(join(tmpdir(), 'aomgit-'));
  const env: ForgeEnv = {
    exec,
    fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch,
    tokens: new MemoryTokenStore(),
    now: () => new Date('2026-10-10T08:00:00Z'),
    processEnv: {},
    ...over,
  };
  return { env, secretsDir };
};

describe('aom git status / connect (the runner drives the login for the DevOps engineer)', () => {
  it('status lists the providers without a secret', async () => {
    const { env, secretsDir } = mk(new FakeExec([[/^gh auth status/, { stdout: 'ok' }]]));
    const g = new AgentGit({ env, secretsDir });
    const r = (await g.handle('git.status', {})) as { ok: true; result: { message: string } };
    expect(r.ok).toBe(true);
    for (const label of ['GitHub', 'GitLab', 'Bitbucket Cloud', 'Azure DevOps'])
      expect(r.result.message).toContain(label);
    expect(((await g.handle('git.status', { provider: 'svn' })) as { ok: boolean }).ok).toBe(false);
  });

  it('a browser login hands the URL and code to the agent, keeps running, and refreshes the status when it ends', async () => {
    const login = fakeLogin(
      '! First copy your one-time code: ABCD-1234\nOpen this URL to continue: https://github.com/login/device\n',
    );
    const calls: Array<[string, string[]]> = [];
    const exec = new FakeExec([[/^gh --version/, { stdout: 'gh 2.60' }]]);
    const { env, secretsDir } = mk(exec);
    const g = new AgentGit({
      env,
      secretsDir,
      waitMs: 3000,
      spawn: (cmd, args) => {
        calls.push([cmd, args]);
        setTimeout(login.say, 10);
        return login.proc;
      },
    });
    const r = (await g.handle('git.connect', { provider: 'github' })) as {
      ok: true;
      result: { state: string; message: string };
    };
    expect(calls).toEqual([['gh', ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https']]]);
    expect(r.result.state).toBe('waiting_for_user');
    expect(r.result.message).toContain('ABCD-1234');
    expect(r.result.message).toContain('https://github.com/login/device');
    expect(r.result.message).toContain('aom git status github');
    // asking again while the sign-in is open does not start a second one
    const again = (await g.handle('git.connect', { provider: 'github' })) as { result: { state: string } };
    expect(again.result.state).toBe('waiting_for_user');
    expect(calls).toHaveLength(1);
    // the user finishes: the credential helper is set up
    login.finish();
    await new Promise((x) => setTimeout(x, 50));
    expect(exec.calls).toContain('gh auth setup-git --hostname github.com');
  });

  it('never starts a login that needs a secret: it tells the user how to connect', async () => {
    const { env, secretsDir } = mk(new FakeExec());
    let spawned = 0;
    const g = new AgentGit({
      env,
      secretsDir,
      spawn: () => {
        spawned++;
        return fakeLogin('').proc;
      },
    });
    for (const provider of ['bitbucket-cloud', 'gitlab', 'azure-devops']) {
      const r = (await g.handle('git.connect', { provider })) as { ok: true; result: { state: string; message: string } };
      expect(r.result.state, provider).toBe('needs_secret');
      expect(r.result.message).toContain(`aom-runner git-connect ${provider}`);
      expect(r.result.message).toMatch(/Do not ask for it in this chat/);
      expect(r.result.message).toMatch(/Connect helper/);
    }
    const az = (await g.handle('git.connect', { provider: 'azure-devops' })) as { result: { message: string } };
    expect(az.result.message).toContain('2026-12-01');
    expect(az.result.message).toContain('service principal');
    expect(spawned).toBe(0);
  });

  it('Azure DevOps uses az login with a device code when the Azure CLI is installed', async () => {
    const login = fakeLogin(
      'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code XYZ123 to authenticate.\n',
    );
    const calls: string[][] = [];
    const { env, secretsDir } = mk(new FakeExec([[/^az --version/, { stdout: 'azure-cli 2.70' }]]));
    const g = new AgentGit({
      env,
      secretsDir,
      waitMs: 3000,
      spawn: (cmd, args) => {
        calls.push([cmd, ...args]);
        setTimeout(login.say, 10);
        return login.proc;
      },
    });
    const r = (await g.handle('git.connect', { provider: 'azure-devops' })) as { result: { message: string } };
    expect(calls).toEqual([['az', 'login', '--use-device-code']]);
    expect(r.result.message).toContain('XYZ123');
    login.finish();
  });

  it('already connected: nothing is started; a bad provider or host is refused', async () => {
    const t = new MemoryTokenStore();
    t.set({ provider: 'gitlab', host: 'gitlab.com', token: 'glpat-SECRET' });
    const { env, secretsDir } = mk(new FakeExec(), { tokens: t });
    env.fetch = (async () => new Response(JSON.stringify({ username: 'jo' }), { status: 200 })) as typeof fetch;
    let spawned = 0;
    const g = new AgentGit({ env, secretsDir, spawn: () => (spawned++, fakeLogin('').proc) });
    const r = (await g.handle('git.connect', { provider: 'gitlab' })) as { result: { state: string; message: string } };
    expect(r.result.state).toBe('connected');
    expect(JSON.stringify(r)).not.toContain('glpat-SECRET');
    expect(spawned).toBe(0);
    expect(((await g.handle('git.connect', { provider: 'nope' })) as { ok: boolean }).ok).toBe(false);
    expect(((await g.handle('git.connect', { provider: 'github', host: 'a b;rm' })) as { ok: boolean }).ok).toBe(false);
  });
});
