import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { entryConfigPath, loadIndex } from '../src/pairings.ts';
import { preparePairing } from '../src/up.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const WS = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const stub = () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ workstationId: WS, runnerToken: `aomr_${'x'.repeat(43)}` }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

describe('guildwise-runner up', () => {
  it('pairs with GUILDWISE_PAIR_CODE once and is a no-op the second time', async () => {
    const dataDir = tmp();
    const { calls, fetchImpl } = stub();
    const env = {
      GUILDWISE_SERVER: 'https://hq.example.com/',
      GUILDWISE_PAIR_CODE: 'ABCD-EFGH',
      GUILDWISE_NAME: 'vps-1',
    };
    const first = await preparePairing({ dataDir, env, fetchImpl });
    expect(first.paired).toBe('code');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://hq.example.com/api/runner/pair');
    expect(calls[0]?.body).toMatchObject({ code: 'ABCD-EFGH', name: 'vps-1' });
    const second = await preparePairing({ dataDir, env, fetchImpl });
    expect(second).toMatchObject({ paired: 'already', workstationId: WS });
    expect(calls).toHaveLength(1);
    expect(loadIndex(dataDir).pairings).toHaveLength(1);
  });

  it('enrolls inside a codespace without a code', async () => {
    const dataDir = tmp();
    const { calls, fetchImpl } = stub();
    const r = await preparePairing({
      dataDir,
      fetchImpl,
      env: {
        GUILDWISE_SERVER: 'https://hq.example.com',
        CODESPACE_NAME: 'verbose-fiesta-1',
        GITHUB_TOKEN: 'ghu_abcdefghij',
      },
    });
    expect(r.paired).toBe('enroll');
    expect(calls[0]?.url).toBe('https://hq.example.com/api/runner/enroll');
    expect(calls[0]?.body).toMatchObject({ codespaceName: 'verbose-fiesta-1' });
  });

  it('refuses without a code when not paired, and stores the customer API key locally', async () => {
    const dataDir = tmp();
    const { fetchImpl } = stub();
    await expect(
      preparePairing({ dataDir, fetchImpl, env: { GUILDWISE_SERVER: 'https://hq.example.com' } }),
    ).rejects.toThrow(/pairing code/);
    const r = await preparePairing({
      dataDir,
      fetchImpl,
      env: {
        GUILDWISE_SERVER: 'https://hq.example.com',
        GUILDWISE_PAIR_CODE: 'ABCD-EFGH',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      },
    });
    expect(r.authApplied).toBe('api_key');
    const entry = loadIndex(dataDir).pairings[0];
    const cfg = loadConfig(entryConfigPath(dataDir, entry as never));
    expect(cfg.runtimes['claude-code']).toMatchObject({ authMode: 'api_key', apiKey: 'sk-ant-test' });
  });
});
