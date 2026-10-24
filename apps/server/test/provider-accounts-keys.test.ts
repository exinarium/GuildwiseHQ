import { randomUUID } from 'node:crypto';
import {
  CLAUDE_ACCOUNTS_CAPABILITY,
  DIRECT_MODEL_CAPABILITY,
  PROVIDER_ACCOUNTS_CAPABILITY,
  PROVIDER_KEYS_BOUND_CAPABILITY,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, MOCK_RUNTIME, until, type World } from './helpers/world.ts';

/**
 * S-A on the workstation side: a named account of a provider key travels as the same sealed command with the account name
 * (only to a runner that keeps accounts), one pending key per provider and account, "Make main" and the AI runtime tiles.
 */
const q = async (sql: string, params: unknown[] = []): Promise<any[]> => rawQ(sql, params) as Promise<any[]>;
let w: World;
let r: FakeRunner;
const KEY = { keyId: 'abcd1234abcd1234', publicKey: 'AAAA' };
const BASE_CAPS = [CLAUDE_ACCOUNTS_CAPABILITY, DIRECT_MODEL_CAPABILITY, PROVIDER_KEYS_BOUND_CAPABILITY];

const call = (method: string, url: string, body?: unknown, cookie = w.owner.cookie) =>
  w.t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) });
const setCaps = (caps: string[]) =>
  q('UPDATE workstation_capabilities SET capabilities = $2 WHERE workstation_id=$1', [w.workstationId, caps]);
const commandsOf = async (type: string, from: number, n = 1) => {
  await until(
    async () => r.received.slice(from).filter((f) => f.type === 'command' && f.command === type).length >= n,
    4000,
    `${n} ${type}`,
  );
  return r.received.slice(from).filter((f) => f.type === 'command' && f.command === type) as any[];
};

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ hello: false });
  r.hello({ runtimes: MOCK_RUNTIME as never, capabilities: BASE_CAPS, sudoKey: KEY });
  await r.waitFor('welcome');
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const putKey = (provider: string, body: Record<string, unknown>) =>
  call('PUT', `/api/workstations/${w.workstationId}/providers/${provider}`, {
    keyId: KEY.keyId,
    ciphertext: 'U0VDUkVULUtFWQ==',
    generation: 1_790_000_000,
    ...body,
  });

describe('a named key account', () => {
  it('is refused for a runner that keeps no accounts (it would store the key as the main key)', async () => {
    const from = r.received.length;
    const res = await putKey('openai', { account: 'work' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('runner_too_old');
    await r.barrier();
    expect(
      r.received.slice(from).filter((f) => f.type === 'command' && f.command === 'provider.key.set'),
    ).toHaveLength(0);
    // the main key still goes
    expect((await putKey('openai', {})).status).toBe(202);
    expect(
      (await call('DELETE', `/api/workstations/${w.workstationId}/providers/openai?account=work`)).status,
    ).toBe(422);
  });

  it('travels as the same sealed command with the account name; one pending key per provider and account', async () => {
    await setCaps([...BASE_CAPS, PROVIDER_ACCOUNTS_CAPABILITY]);
    const from = r.received.length;
    expect((await putKey('openai', { account: 'work', models: ['gpt-5.1'] })).status).toBe(202);
    expect((await putKey('openai', { account: 'personal' })).status).toBe(202);
    const sent = await commandsOf('provider.key.set', from, 2);
    expect(sent.map((c) => c.payload.account)).toEqual(expect.arrayContaining(['work', 'personal']));
    const work = sent.find((c) => c.payload.account === 'work');
    expect(work.payload).toMatchObject({
      provider: 'openai',
      account: 'work',
      keyId: KEY.keyId,
      ciphertext: 'U0VDUkVULUtFWQ==',
      generation: 1_790_000_000,
    });
    // a second key for the same account replaces the one that waits; the other account's stays
    await q(
      `UPDATE runner_commands SET status='pending' WHERE type='provider.key.set' AND payload->>'account' IS NOT NULL`,
    );
    expect((await putKey('openai', { account: 'work' })).status).toBe(202);
    const pending = await q(
      `SELECT payload->>'account' AS account, status FROM runner_commands
        WHERE type='provider.key.set' AND workstation_id=$1 AND payload->>'account' IS NOT NULL
          AND payload <> '{}'::jsonb ORDER BY created_at`,
      [w.workstationId],
    );
    expect(pending.filter((x) => x.account === 'personal')).toHaveLength(1);
  });

  it('the answer is forgotten like the main key’s, and no event holds the key', async () => {
    const from = r.received.length;
    await putKey('anthropic', { account: 'team' });
    const cmd = await r.waitFor(
      'command',
      (c) => c.command === 'provider.key.set' && c.payload.account === 'team',
      5000,
      from,
    );
    r.send('command.result', { commandId: cmd.commandId, ok: true, result: { stored: true } });
    await r.barrier();
    await until(
      async () =>
        (await q('SELECT payload FROM runner_commands WHERE id=$1', [cmd.commandId]))[0]?.payload?.keyId ===
        undefined,
    );
    expect(await q(`SELECT 1 FROM events WHERE payload::text LIKE '%U0VDUkVULUtFWQ%'`)).toEqual([]);
  });

  it('removing an account sends the name; a bad name is refused; only the owner may', async () => {
    const from = r.received.length;
    expect(
      (await call('DELETE', `/api/workstations/${w.workstationId}/providers/openai?account=work`)).status,
    ).toBe(202);
    const clear = (await commandsOf('provider.key.clear', from))[0];
    expect(clear.payload).toEqual({ provider: 'openai', account: 'work' });
    expect(
      (await call('DELETE', `/api/workstations/${w.workstationId}/providers/openai?account=main`)).status,
    ).toBe(400);
    expect(
      (await call('DELETE', `/api/workstations/${w.workstationId}/providers/openai?account=Bad`)).status,
    ).toBe(400);
    const other = await w.t.userSession(`other-${randomUUID().slice(0, 6)}@example.test`);
    expect(
      (
        await call(
          'PUT',
          `/api/workstations/${w.workstationId}/providers/openai`,
          { keyId: KEY.keyId, ciphertext: 'Zm9v', account: 'x' },
          other.cookie,
        )
      ).status,
    ).toBe(404);
  });
});

describe('Make main', () => {
  const promote = (body: unknown, cookie = w.owner.cookie) =>
    call('POST', `/api/workstations/${w.workstationId}/accounts/promote`, body, cookie);

  it('queues the swap for the runner, and remembers its answer for the page', async () => {
    const from = r.received.length;
    expect((await promote({ scope: 'openai', key: 'work' })).status).toBe(202);
    const cmd = (await commandsOf('provider.account.promote', from))[0];
    expect(cmd.payload).toEqual({ scope: 'openai', key: 'work' });
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: false, error: 'there is no openai key under the account work' },
    });
    await r.barrier();
    await until(
      async () =>
        (await call('GET', `/api/workstations/${w.workstationId}/ai-runtimes`)).body.lastPromote !== null,
    );
    const page = (await call('GET', `/api/workstations/${w.workstationId}/ai-runtimes`)).body;
    expect(page.lastPromote).toMatchObject({
      scope: 'openai',
      key: 'work',
      ok: false,
      error: expect.stringContaining('no openai key'),
    });
  });

  it('refuses main and org as the account, Claude Code, an unknown scope, a stranger and a runner without accounts', async () => {
    expect((await promote({ scope: 'openai', key: 'main' })).status).toBe(400);
    expect((await promote({ scope: 'openai', key: 'org' })).status).toBe(400);
    expect((await promote({ scope: 'nope', key: 'work' })).status).toBe(400);
    const cc = await promote({ scope: 'claude-code', key: 'work' });
    expect(cc.status).toBe(422);
    const other = await w.t.userSession(`other-${randomUUID().slice(0, 6)}@example.test`);
    expect((await promote({ scope: 'openai', key: 'work' }, other.cookie)).status).toBe(404);
    await setCaps(BASE_CAPS);
    expect((await promote({ scope: 'openai', key: 'work' })).status).toBe(422);
    await setCaps([...BASE_CAPS, PROVIDER_ACCOUNTS_CAPABILITY]);
  });
});

describe('the AI runtime tiles', () => {
  const info = (key: string, over: Record<string, unknown> = {}) => ({
    key,
    main: key === 'main',
    source: 'config_dir',
    login: 'ok',
    usage: 'ok',
    ...over,
  });

  it('are built from what the runner reported: installed or not, accounts and their state, the key in effect', async () => {
    r.send('runtimes.report', {
      runtimes: [
        ...MOCK_RUNTIME,
        {
          id: 'claude-code',
          version: '2.1.0',
          available: true,
          capabilities: ['shell'],
          accounts: [info('main')],
        },
        {
          id: 'codex',
          version: '0.163.0',
          available: true,
          capabilities: ['shell'],
          accounts: [info('main'), info('work', { login: 'expired', email: 'w@x.test' })],
        },
        {
          id: 'direct-model',
          version: 'v',
          available: true,
          capabilities: ['skills'],
          keys: [
            { provider: 'openai', source: 'workstation', accounts: ['work', 'personal'] },
            { provider: 'anthropic', source: 'org', orgKey: true, orgIds: [randomUUID()], accounts: [] },
          ],
        },
      ],
    });
    await r.barrier();
    const res = await call('GET', `/api/workstations/${w.workstationId}/ai-runtimes`);
    expect(res.status).toBe(200);
    const tile = (id: string) => res.body.tiles.find((t: any) => t.id === id);
    expect(res.body).toMatchObject({ workstationId: w.workstationId, online: true });
    expect(tile('codex')).toMatchObject({ installed: true, runnerTooOld: false, integrationKind: 'codex' });
    expect(tile('codex').accounts.map((a: any) => [a.key, a.state])).toEqual([
      ['main', 'ok'],
      ['work', 'expired'],
    ]);
    expect(tile('gemini')).toMatchObject({
      installed: false,
      installHint: expect.stringContaining('gemini-cli'),
    });
    expect(tile('opencode')).toMatchObject({ installed: false });
    expect(tile('openai').accounts.map((a: any) => a.key)).toEqual(['main', 'work', 'personal']);
    expect(tile('openai').accounts[0]).toMatchObject({ state: 'ok', source: 'workstation' });
    expect(tile('google').accounts).toMatchObject([{ key: 'main', state: 'none' }]);
    expect(tile('google').keyInEffect).toBe('none');
    expect(tile('anthropic')).toMatchObject({ keyInEffect: 'org' });
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|ciphertext/);
  });

  it('only the workstation’s owner sees them', async () => {
    const other = await w.t.userSession(`other-${randomUUID().slice(0, 6)}@example.test`);
    expect(
      (await call('GET', `/api/workstations/${w.workstationId}/ai-runtimes`, undefined, other.cookie)).status,
    ).toBe(404);
  });

  it('an older runner is told to update for everything but Claude Code', async () => {
    await setCaps(BASE_CAPS);
    const res = await call('GET', `/api/workstations/${w.workstationId}/ai-runtimes`);
    const tile = (id: string) => res.body.tiles.find((t: any) => t.id === id);
    expect(tile('claude-code').runnerTooOld).toBe(false);
    expect(tile('codex').runnerTooOld).toBe(true);
    expect(tile('openai').runnerTooOld).toBe(true);
  });
});

describe('sign-in kinds on the Integrations routes', () => {
  it('Codex and the Gemini CLI sign-ins need a runner that has accounts', async () => {
    await setCaps(BASE_CAPS);
    await q('UPDATE workstations SET integrations_version = 1 WHERE id=$1', [w.workstationId]);
    const res = await call('POST', `/api/workstations/${w.workstationId}/integrations/sessions`, {
      kind: 'codex',
      instance: 'work',
      method: 'codex_login',
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('runner_too_old');
  });
});
