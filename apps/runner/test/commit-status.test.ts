import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiveOnce, postCommitStatus } from '../src/forge/commit-status.ts';
import { saveStatusToken, statusTokenStatusLines } from '../src/forge/status-token-cli.ts';
import { FileStatusTokenStore, MemoryStatusTokenStore } from '../src/forge/status-tokens.ts';
import type { ForgeEnv } from '../src/forge/types.ts';
import { MemoryTokenStore } from '../src/forge/index.ts';

const TOKEN = 'github_pat_FAKE_status_0123456789';
const SHA = 'a'.repeat(40);
const payload = (over: Record<string, unknown> = {}) =>
  ({
    statusId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
    remoteUrlNormalized: 'github.com/o/r',
    sha: SHA,
    state: 'failure',
    context: 'size-budget',
    description: 'Over budget: 700 changed lines, budget 600 changed lines',
    ...over,
  }) as never;

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}
/** A fake GitHub: records every request and answers with the given status. */
function github(status = 201) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(status < 300 ? { id: 1 } : { message: `bad ${TOKEN}` }), { status });
  }) as unknown as typeof fetch;
  return { calls, f };
}

function env(f: typeof fetch, withToken = true, host = 'github.com'): ForgeEnv {
  const statusTokens = new MemoryStatusTokenStore();
  if (withToken) statusTokens.set('github', host, TOKEN);
  return {
    exec: { run: async () => ({ exitCode: 1, stdout: '', stderr: 'the gh login must not be used' }) } as never,
    fetch: f,
    tokens: new MemoryTokenStore(),
    statusTokens,
  };
}

describe('commit status (GWP-211)', () => {
  it('AC1: posts exactly one failure status with the size check context to the commit', async () => {
    const g = github();
    const r = await postCommitStatus({
      payload: payload(),
      remoteUrl: 'https://github.com/o/r.git',
      forgeEnv: env(g.f),
    });
    expect(r).toEqual({ ok: true });
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]?.url).toBe(`https://api.github.com/repos/o/r/statuses/${SHA}`);
    expect(g.calls[0]?.init.method).toBe('POST');
    expect(g.calls[0]?.body).toEqual({
      state: 'failure',
      context: 'size-budget',
      description: 'Over budget: 700 changed lines, budget 600 changed lines',
    });
  });

  it('keeps the token in the Authorization header only', async () => {
    const g = github();
    await postCommitStatus({ payload: payload(), remoteUrl: 'https://github.com/o/r.git', forgeEnv: env(g.f) });
    const call = g.calls[0] as Call;
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.url).not.toContain(TOKEN);
    expect(JSON.stringify(call.body)).not.toContain(TOKEN);
  });

  it('without a token it answers no_token and sends no request', async () => {
    const g = github();
    const r = await postCommitStatus({
      payload: payload(),
      remoteUrl: 'https://github.com/o/r.git',
      forgeEnv: env(g.f, false),
    });
    expect(r).toMatchObject({ ok: false, code: 'no_token' });
    expect(g.calls).toHaveLength(0);
  });

  it.each([
    [401, 'no_token'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [422, 'invalid_sha'],
    [500, 'error'],
  ])('maps a %i answer to %s without the token in the error', async (status, code) => {
    const g = github(status);
    const r = await postCommitStatus({ payload: payload(), remoteUrl: 'https://github.com/o/r.git', forgeEnv: env(g.f) });
    expect(r).toMatchObject({ ok: false, code });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('a network error is an error answer without the token', async () => {
    const f = (async () => {
      throw new Error(`connect failed ${TOKEN}`);
    }) as unknown as typeof fetch;
    const r = await postCommitStatus({ payload: payload(), remoteUrl: 'https://github.com/o/r.git', forgeEnv: env(f) });
    expect(r).toMatchObject({ ok: false, code: 'error' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('uses the /api/v3 base and the host token for GitHub Enterprise Server', async () => {
    const g = github();
    const r = await postCommitStatus({
      payload: payload({ remoteUrlNormalized: 'ghe.example.com/o/r', forge: 'github' }),
      remoteUrl: 'https://ghe.example.com/o/r.git',
      forgeEnv: env(g.f, true, 'ghe.example.com'),
    });
    expect(r).toEqual({ ok: true });
    expect(g.calls[0]?.url).toBe(`https://ghe.example.com/api/v3/repos/o/r/statuses/${SHA}`);
  });

  it('answers no_clone without a clone and unsupported for a host without statuses', async () => {
    const g = github();
    expect(await postCommitStatus({ payload: payload(), remoteUrl: null, forgeEnv: env(g.f) })).toMatchObject({
      ok: false,
      code: 'no_clone',
    });
    expect(
      await postCommitStatus({
        payload: payload({ remoteUrlNormalized: 'gitlab.com/o/r' }),
        remoteUrl: 'https://gitlab.com/o/r.git',
        forgeEnv: env(g.f),
      }),
    ).toMatchObject({ ok: false, code: 'unsupported' });
    expect(g.calls).toHaveLength(0);
  });

  it('shares one live post between resent commands', async () => {
    const once = new LiveOnce<number>();
    let runs = 0;
    const slow = () =>
      new Promise<number>((res) =>
        setTimeout(() => {
          runs++;
          res(runs);
        }, 10),
      );
    const [a, b] = await Promise.all([once.once('k', slow), once.once('k', slow)]);
    expect(a).toBe(b);
    expect(runs).toBe(1);
    await once.once('k', slow);
    expect(runs).toBe(2);
  });
});

describe('status token store (GWP-211)', () => {
  const key = () => Buffer.alloc(32, 7);

  it('keeps the token sealed on disk and lists keys without values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-tokens-'));
    const file = join(dir, 'status-tokens.json');
    const store = new FileStatusTokenStore(file, key);
    store.set('github', 'GitHub.com', TOKEN);
    expect(readFileSync(file, 'utf8')).not.toContain(TOKEN);
    expect(store.get('github', 'github.com')?.token).toBe(TOKEN);
    expect(store.list().map((t) => t.key)).toEqual(['github@github.com']);
    expect(JSON.stringify(store.list())).not.toContain(TOKEN);
    expect(statusTokenStatusLines(store).join('\n')).not.toContain(TOKEN);
    expect(new FileStatusTokenStore(file, key).get('github', 'github.com')?.token).toBe(TOKEN);
    expect(store.remove('github', 'github.com')).toBe(true);
    expect(store.get('github', 'github.com')).toBeUndefined();
  });

  it('reports a file that cannot be read and never overwrites it silently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-tokens-'));
    const file = join(dir, 'status-tokens.json');
    new FileStatusTokenStore(file, key).set('github', 'github.com', TOKEN);
    const other = new FileStatusTokenStore(file, () => Buffer.alloc(32, 9));
    expect(other.problem()).toMatch(/status token/);
    expect(statusTokenStatusLines(other)[0]).toMatch(/status token/);
  });

  it('saveStatusToken refuses an empty token and a bad host', () => {
    const store = new MemoryStatusTokenStore();
    expect(saveStatusToken({ store, host: 'github.com', token: '  ' }).ok).toBe(false);
    expect(saveStatusToken({ store, host: 'a/b', token: TOKEN }).ok).toBe(false);
    expect(saveStatusToken({ store, host: 'github.com', token: TOKEN }).ok).toBe(true);
    expect(store.get('github', 'github.com')?.token).toBe(TOKEN);
  });
});
