import type { IntegrationRunPayload, TrackerApp } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { AppTokenError } from '../src/apps/types.ts';
import type { AppTokenSource } from '../src/external/app-token.ts';
import type { Exec } from '../src/external/github.ts';
import { IntegrationPoller } from '../src/integrations/poll.ts';

const APP: TrackerApp = {
  integrationId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c9',
  provider: 'github-app',
  label: 'Acme bot',
  botName: 'acme-bot[bot]',
  botEmail: '42+acme-bot[bot]@users.noreply.github.com',
  instance: '4242:777',
  host: 'github.com',
};
const TOKEN = 'ghs_polltoken0123456789abcdefABCDEF';
const payload = (over: Partial<IntegrationRunPayload> = {}): IntegrationRunPayload => ({
  scheduleId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
  integration: 'github',
  query: 'acme/toy',
  limit: 30,
  ...over,
});

/**
 * A mocked GitHub API behind a fake `gh`: like `gh`, it turns GH_TOKEN into the Authorization header, and with no
 * GH_TOKEN it uses the workstation login.
 */
function mockedGithub() {
  const headers: Array<string> = [];
  const calls: Array<{ args: string[]; argc: number }> = [];
  const exec: Exec = async (...a: Parameters<Exec>) => {
    const [, args, opts] = a;
    calls.push({ args, argc: a.length });
    headers.push(opts?.env?.GH_TOKEN ? `token ${opts.env.GH_TOKEN}` : 'token personal-login');
    return {
      exitCode: 0,
      stdout: JSON.stringify([{ number: 3, title: 'Crash', body: 'b', url: 'u', labels: [{ name: 'bug' }] }]),
      stderr: '',
    };
  };
  return { headers, calls, exec };
}

const source = (fail?: string) => {
  const asked: Array<[string, string, string]> = [];
  const src: AppTokenSource = {
    tokenFor: async (app, repo) => {
      asked.push([app.instance, app.integrationId, repo]);
      if (fail) throw new AppTokenError(fail as never, 'boom');
      return TOKEN;
    },
  };
  return { asked, src };
};

describe('IntegrationPoller (GitHub) as the selected app', () => {
  it('polls with the app token as the Authorization header', async () => {
    const api = mockedGithub();
    const s = source();
    const r = await new IntegrationPoller({ exec: api.exec, appTokens: s.src }).run(
      payload({ trackerApp: APP }),
    );
    expect(r).toMatchObject({ ok: true, issues: [{ key: 'acme/toy#3', title: 'Crash' }] });
    expect(api.headers).toEqual([`token ${TOKEN}`]);
    expect(s.asked).toEqual([['4242:777', APP.integrationId, 'acme/toy']]);
    expect(api.calls[0]?.args.join(' ')).not.toContain(TOKEN);
  });

  it('without an app it polls exactly as before (no env, two arguments)', async () => {
    const api = mockedGithub();
    const s = source();
    const r = await new IntegrationPoller({ exec: api.exec, appTokens: s.src }).run(payload());
    expect(r.ok).toBe(true);
    expect(api.calls[0]?.argc).toBe(2);
    expect(api.headers).toEqual(['token personal-login']);
    expect(s.asked).toEqual([]);
  });

  it('a repository outside the installation uses the workstation login', async () => {
    const api = mockedGithub();
    const r = await new IntegrationPoller({
      exec: api.exec,
      appTokens: source('repository_not_accessible').src,
    }).run(payload({ trackerApp: APP }));
    expect(r.ok).toBe(true);
    expect(api.headers).toEqual(['token personal-login']);
  });

  it('an app that cannot mint fails the poll, naming the app, and gh never runs', async () => {
    const api = mockedGithub();
    const r = await new IntegrationPoller({
      exec: api.exec,
      appTokens: source('installation_suspended').src,
    }).run(payload({ trackerApp: APP }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/GitHub App Acme bot/);
    expect(api.calls).toEqual([]);
  });
});
