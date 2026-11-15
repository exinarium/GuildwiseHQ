import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovedDraft, OutboundPostPayload, TrackerApp } from '@aom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredApp } from '../src/apps/types.ts';
import { AppTokenError } from '../src/apps/types.ts';
import { type AppTokenSource, brokerTokenSource, ghEnvFor } from '../src/external/app-token.ts';
import {
  type Exec,
  ExternalAdapters,
  GithubAdapter,
  PostError,
  SourceReadError,
} from '../src/external/index.ts';
import { OutboundExecutor } from '../src/external/outbound.ts';

const DRAFT = '019e3f6a-7b1c-7a2d-8c3e-0123456789b1';
const INTEGRATION = '019e3f6a-7b1c-7a2d-8c3e-0123456789b9';
const APP: TrackerApp = {
  integrationId: INTEGRATION,
  provider: 'github-app',
  label: 'Acme bot',
  botName: 'acme-bot[bot]',
  botEmail: '42+acme-bot[bot]@users.noreply.github.com',
  instance: '4242:777',
  host: 'github.com',
};
const TOKEN = 'ghs_testtoken0123456789abcdefABCDEF';
const BODY = 'The export now includes archived items.';

const draft = (over: Partial<ApprovedDraft> = {}): ApprovedDraft => ({
  draftId: DRAFT,
  ref: { system: 'github', key: 'acme/toy#7' },
  kind: 'comment',
  body: BODY,
  ...over,
});
const payload = (over: Partial<OutboundPostPayload> = {}): OutboundPostPayload => ({
  draftId: DRAFT,
  cardId: '019e3f6a-7b1c-7a2d-8c3e-0123456789b2',
  cardRef: 'TOY-1',
  ref: { system: 'github', key: 'acme/toy#7' },
  kind: 'comment',
  body: BODY,
  agentNames: [],
  ...over,
});

type Call = { bin: string; args: string[]; opts?: { env?: Record<string, string> }; argc: number };
/** A fake `gh`: records every call (with the env it got) and answers from `respond`. */
function fakeGh(
  respond: (args: string[]) => { exitCode?: number; stdout?: string; stderr?: string } = () => ({}),
) {
  const calls: Call[] = [];
  const exec: Exec = async (...a: Parameters<Exec>) => {
    const [bin, args, opts] = a;
    calls.push({ bin, args, ...(opts ? { opts } : {}), argc: a.length });
    const r = respond(args);
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { calls, exec };
}

function tokens(impl?: (repo: string) => Promise<string>) {
  const asked: Array<{ app: { instance: string; integrationId: string }; repo: string }> = [];
  const src: AppTokenSource = {
    tokenFor: async (app, repo) => {
      asked.push({ app: { instance: app.instance, integrationId: app.integrationId }, repo });
      return impl ? impl(repo) : TOKEN;
    },
  };
  return { asked, src };
}
const failing = (code: ConstructorParameters<typeof AppTokenError>[0]) =>
  tokens(async () => {
    throw new AppTokenError(code, 'boom');
  });

describe('brokerTokenSource (the runner broker as a token source)', () => {
  const stored = (over: Partial<StoredApp> = {}): StoredApp =>
    ({
      provider: 'github-app',
      host: 'github.com',
      appRef: '4242',
      appId: '4242',
      installationId: '777',
      privateKey: 'pem',
      identity: { account: 'Acme' },
      refs: [{ orgId: 'o', integrationId: INTEGRATION }],
      local: false,
      savedAt: '2026-11-15T00:00:00Z',
      ...over,
    }) as StoredApp;
  const broker = (s: StoredApp | undefined) => {
    const scopes: unknown[] = [];
    return {
      scopes,
      b: {
        store: { get: (i: string) => (i === '4242:777' ? s : undefined) },
        getAccessToken: async (instance: string, scope?: unknown) => {
          scopes.push({ instance, scope });
          return { token: TOKEN };
        },
      },
    };
  };

  it('mints on the instance, scoped to the repository name only', async () => {
    const { b, scopes } = broker(stored());
    expect(await brokerTokenSource(() => b).tokenFor(APP, 'acme/toy')).toBe(TOKEN);
    expect(scopes).toEqual([{ instance: '4242:777', scope: { repositories: ['toy'] } }]);
  });

  it('another owner than the installation account is not covered (no token for a same-named repository)', async () => {
    const { b, scopes } = broker(stored());
    await expect(brokerTokenSource(() => b).tokenFor(APP, 'someone-else/toy')).rejects.toMatchObject({
      code: 'repository_not_accessible',
    });
    expect(scopes).toEqual([]);
  });

  it('a copy of another registration is app_mismatch; no copy is installation_not_found', async () => {
    const other = broker(stored({ refs: [{ orgId: 'o', integrationId: 'someone-else' }] }));
    await expect(brokerTokenSource(() => other.b).tokenFor(APP, 'acme/toy')).rejects.toMatchObject({
      code: 'app_mismatch',
    });
    const none = broker(undefined);
    await expect(brokerTokenSource(() => none.b).tokenFor(APP, 'acme/toy')).rejects.toMatchObject({
      code: 'installation_not_found',
    });
  });
});

describe('ghEnvFor (covered, fallback, fail closed)', () => {
  it('no app or an app on another host: today’s login (undefined), no token asked', async () => {
    const t = tokens();
    expect(await ghEnvFor(t.src, undefined, 'acme/toy')).toBeUndefined();
    expect(await ghEnvFor(t.src, { ...APP, host: 'ghe.acme.test' }, 'acme/toy')).toBeUndefined();
    expect(t.asked).toEqual([]);
  });

  it('covered: GH_TOKEN with GH_HOST pinned to github.com', async () => {
    expect(await ghEnvFor(tokens().src, APP, 'acme/toy')).toEqual({
      GH_TOKEN: TOKEN,
      GH_HOST: 'github.com',
      GH_PROMPT_DISABLED: '1',
    });
  });

  it('repository not in the installation falls back; any other failure names the app', async () => {
    expect(await ghEnvFor(failing('repository_not_accessible').src, APP, 'acme/toy')).toBeUndefined();
    await expect(ghEnvFor(failing('installation_suspended').src, APP, 'acme/toy')).rejects.toThrow(
      /GitHub App Acme bot \(acme-bot\[bot\]\).*Nothing was sent under another identity/,
    );
    await expect(ghEnvFor(undefined, APP, 'acme/toy')).rejects.toThrow(/Acme bot/);
  });
});

describe('GithubAdapter as the selected app', () => {
  it('posts with the installation token in the child env, never in the arguments', async () => {
    const gh = fakeGh(() => ({ stdout: 'https://github.com/acme/toy/issues/7#issuecomment-1' }));
    const t = tokens();
    const a = new GithubAdapter({ exec: gh.exec, appTokens: t.src });
    const r = await a.postApproved(draft(), { app: APP });
    expect(r.externalRef).toBe('https://github.com/acme/toy/issues/7#issuecomment-1');
    expect(gh.calls).toHaveLength(1);
    const [call] = gh.calls;
    expect(call?.args).toEqual(['issue', 'comment', '7', '--repo', 'acme/toy', '--body', BODY]);
    expect(call?.opts?.env).toEqual({ GH_TOKEN: TOKEN, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' });
    expect(call?.args.join(' ')).not.toContain(TOKEN);
    expect(t.asked).toEqual([
      { app: { instance: '4242:777', integrationId: INTEGRATION }, repo: 'acme/toy' },
    ]);
  });

  it('without an app it calls gh exactly as before (two arguments, no env), even with a token source', async () => {
    const gh = fakeGh();
    const t = tokens();
    await new GithubAdapter({ exec: gh.exec, appTokens: t.src }).postApproved(draft());
    expect(gh.calls[0]?.argc).toBe(2);
    expect(gh.calls[0]?.opts).toBeUndefined();
    expect(t.asked).toEqual([]);
  });

  it('a repository the installation does not cover is posted with today’s login', async () => {
    const gh = fakeGh();
    await new GithubAdapter({
      exec: gh.exec,
      appTokens: failing('repository_not_accessible').src,
    }).postApproved(draft(), { app: APP });
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]?.argc).toBe(2);
  });

  it('minting fails: PostError naming the app, and gh never runs', async () => {
    const gh = fakeGh();
    const a = new GithubAdapter({ exec: gh.exec, appTokens: failing('installation_suspended').src });
    const err = await a.postApproved(draft(), { app: APP }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PostError);
    expect((err as Error).message).toMatch(/Acme bot \(acme-bot\[bot\]\)/);
    expect(gh.calls).toEqual([]);
  });

  it('issue reads use the app too, and a failing app is a SourceReadError', async () => {
    const gh = fakeGh(() => ({ stdout: JSON.stringify({ title: 'Bug', body: 'b' }) }));
    const ok = new ExternalAdapters([new GithubAdapter({ exec: gh.exec, appTokens: tokens().src })]);
    expect((await ok.readText('acme/toy#7', { app: APP })).title).toBe('Bug');
    expect(gh.calls[0]?.opts?.env?.GH_TOKEN).toBe(TOKEN);
    const bad = new GithubAdapter({ exec: gh.exec, appTokens: failing('key_invalid').src });
    await expect(
      bad.readSource({ system: 'github', key: 'acme/toy#7' }, { app: APP }),
    ).rejects.toBeInstanceOf(SourceReadError);
  });

  it('a token in gh output is redacted from the error', async () => {
    const gh = fakeGh(() => ({ exitCode: 1, stderr: `HTTP 401 for token ${TOKEN}` }));
    const err = await new GithubAdapter({ exec: gh.exec }).postApproved(draft()).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('findPosted matches the text whoever posted it: the personal login or the bot', async () => {
    for (const author of ['pieter', 'acme-bot']) {
      const gh = fakeGh(() => ({
        stdout: JSON.stringify({
          url: 'https://github.com/acme/toy/issues/7',
          comments: [{ author: { login: author }, body: `${BODY}\n`, url: `https://x/${author}` }],
        }),
      }));
      const a = new GithubAdapter({ exec: gh.exec, appTokens: tokens().src });
      expect(await a.findPosted(draft(), { app: APP })).toEqual({ externalRef: `https://x/${author}` });
    }
  });
});

describe('the outbound executor with a selected app (no duplicates across the switch)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aom-tracker-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const issueWith = (bodies: string[]) =>
    JSON.stringify({
      url: 'https://github.com/acme/toy/issues/7',
      comments: bodies.map((b) => ({ body: b })),
    });

  it('the payload’s trackerApp reaches gh as GH_TOKEN', async () => {
    const gh = fakeGh();
    const ex = new OutboundExecutor({
      dir,
      adapters: new ExternalAdapters([new GithubAdapter({ exec: gh.exec, appTokens: tokens().src })]),
    });
    expect(await ex.run(payload({ trackerApp: APP }), 'c1')).toMatchObject({ ok: true });
    expect(gh.calls[0]?.opts?.env?.GH_TOKEN).toBe(TOKEN);
  });

  it('an ambiguous personal-login attempt, retried as the app, finds the text and posts nothing', async () => {
    let posted = false;
    const gh = fakeGh((args) => {
      if (args[1] === 'comment') {
        posted = true;
        throw new Error('socket hang up');
      }
      return { stdout: issueWith(posted ? [BODY] : []) };
    });
    const ex = new OutboundExecutor({
      dir,
      adapters: new ExternalAdapters([new GithubAdapter({ exec: gh.exec, appTokens: tokens().src })]),
    });
    expect(await ex.run(payload(), 'c1')).toMatchObject({ ok: false });
    expect(await ex.run(payload({ trackerApp: APP }), 'c2')).toMatchObject({ ok: true, duplicate: true });
    expect(gh.calls.filter((c) => c.args[1] === 'comment')).toHaveLength(1);
    expect(gh.calls.at(-1)?.opts?.env?.GH_TOKEN).toBe(TOKEN);
  });

  it('ambiguous attempt -> refused while the app cannot mint -> fixed app: looks first, posts nothing', async () => {
    let mintOk = true;
    let landed = false;
    const t = tokens(async () => {
      if (!mintOk) throw new AppTokenError('installation_suspended', 'boom');
      return TOKEN;
    });
    const gh = fakeGh((args) => {
      if (args[1] === 'comment') {
        landed = true;
        throw new Error('timeout');
      }
      return { stdout: issueWith(landed ? [BODY] : []) };
    });
    const ex = new OutboundExecutor({
      dir,
      adapters: new ExternalAdapters([new GithubAdapter({ exec: gh.exec, appTokens: t.src })]),
    });
    const p = payload({ trackerApp: APP });
    expect(await ex.run(p, 'c1')).toMatchObject({ ok: false });
    mintOk = false;
    const refused = await ex.run(p, 'c2');
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toMatch(/Acme bot/);
    const rec = JSON.parse(readFileSync(join(dir, `${DRAFT}.json`), 'utf8'));
    expect(rec).toMatchObject({ state: 'refused', commandId: 'c2', lookFirst: true });
    mintOk = true;
    expect(await ex.run(p, 'c3')).toMatchObject({ ok: true, duplicate: true });
    expect(gh.calls.filter((c) => c.args[1] === 'comment')).toHaveLength(1);
  });

  it('with the app failing nothing is posted under another identity', async () => {
    const gh = fakeGh();
    const ex = new OutboundExecutor({
      dir,
      adapters: new ExternalAdapters([
        new GithubAdapter({ exec: gh.exec, appTokens: failing('permission_missing').src }),
      ]),
    });
    const r = await ex.run(payload({ trackerApp: APP }), 'c1');
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/GitHub App Acme bot/);
    expect(gh.calls).toEqual([]);
  });
});
