import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovedDraft, OutboundPostPayload } from '@aom/shared';
import { MockAgent, fetch as undiciFetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Exec, ExternalAdapters, GithubAdapter, JiraAdapter, PostError } from '../src/external/index.ts';
import { OutboundExecutor } from '../src/external/outbound.ts';

const DRAFT = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const draft = (over: Partial<ApprovedDraft> = {}): ApprovedDraft => ({
  draftId: DRAFT,
  ref: { system: 'jira', key: 'ABC-1' },
  kind: 'comment',
  body: 'The export now includes archived items.',
  ...over,
});
const payload = (over: Partial<OutboundPostPayload> = {}): OutboundPostPayload => ({
  draftId: DRAFT,
  cardId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2',
  cardRef: 'TOY-1',
  ref: { system: 'jira', key: 'ABC-1' },
  kind: 'comment',
  body: 'The export now includes archived items.',
  agentNames: [],
  ...over,
});

const JIRA = { baseUrl: 'https://acme.atlassian.example', email: 'me@acme.test', apiToken: 'sekret' };
const basic = `Basic ${Buffer.from('me@acme.test:sekret').toString('base64')}`;

let agent: MockAgent;
let dir: string;
beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  dir = mkdtempSync(join(tmpdir(), 'aom-outbound-'));
});
afterEach(async () => {
  await agent.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Jira over undici's MockAgent: no request ever leaves the process. */
const jira = (config: typeof JIRA | null = JIRA) =>
  new JiraAdapter({
    config: config ?? undefined,
    fetch: (url, init) =>
      undiciFetch(url, { ...(init as object), dispatcher: agent }) as unknown as Promise<Response>,
  });
const pool = () => agent.get(JIRA.baseUrl);

function fakeGh(stdout = '', exitCode = 0, stderr = '') {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const exec: Exec = async (bin, args) => {
    calls.push({ bin, args });
    return { exitCode, stdout, stderr };
  };
  return { calls, exec };
}

describe('Jira posting (REST with the token in the runner config)', () => {
  it('posts the approved text exactly, with the configured credentials, and returns the comment link', async () => {
    let seen: { auth?: string; body?: string } = {};
    pool()
      .intercept({ path: '/rest/api/2/issue/ABC-1/comment', method: 'POST' })
      .reply(201, (opts) => {
        seen = { auth: (opts.headers as Record<string, string>).authorization, body: String(opts.body) };
        return { id: '10042' };
      });
    const r = await jira().postApproved(draft({ body: 'Line one.\n\nLine "two" & more.' }));
    expect(seen.auth).toBe(basic);
    expect(JSON.parse(seen.body as string)).toEqual({ body: 'Line one.\n\nLine "two" & more.' });
    expect(r.externalRef).toBe('https://acme.atlassian.example/browse/ABC-1?focusedCommentId=10042');
  });

  it('uses a bearer token when no email is configured (Data Center)', async () => {
    let auth = '';
    pool()
      .intercept({ path: '/rest/api/2/issue/ABC-1/comment', method: 'POST' })
      .reply(201, (opts) => {
        auth = (opts.headers as Record<string, string>).authorization as string;
        return { id: '1' };
      });
    await jira({ baseUrl: JIRA.baseUrl, apiToken: 'pat', email: undefined } as never).postApproved(draft());
    expect(auth).toBe('Bearer pat');
  });

  it('refuses without credentials and reports what Jira refused', async () => {
    await expect(jira(null).postApproved(draft())).rejects.toThrow(/no Jira credentials on this workstation/);
    pool()
      .intercept({ path: '/rest/api/2/issue/ABC-1/comment', method: 'POST' })
      .reply(401, { errorMessages: ['bad token'] });
    const err = await jira()
      .postApproved(draft())
      .catch((e) => e);
    expect(err).toBeInstanceOf(PostError);
    expect(err.message).toMatch(/Jira answered 401 for ABC-1/);
  });

  it('finds an earlier identical comment (used before posting again after an ambiguous failure)', async () => {
    pool()
      .intercept({ path: /\/rest\/api\/2\/issue\/ABC-1\/comment\?/, method: 'GET' })
      .reply(200, {
        comments: [
          { id: '7', body: 'something else' },
          { id: '9', body: 'The export now includes archived items. ' },
        ],
      });
    expect((await jira().findPosted(draft()))?.externalRef).toMatch(/focusedCommentId=9$/);
  });
});

describe('GitHub posting (gh issue comment / close)', () => {
  it('comments on the issue with the text as it is', async () => {
    const f = fakeGh('https://github.com/acme/toy/issues/12#issuecomment-55\n');
    const r = await new GithubAdapter({ exec: f.exec, bin: '/fake/gh' }).postApproved(
      draft({ ref: { system: 'github', key: 'acme/toy#12' }, body: 'Fixed in main.' }),
    );
    expect(f.calls).toEqual([
      { bin: '/fake/gh', args: ['issue', 'comment', '12', '--repo', 'acme/toy', '--body', 'Fixed in main.'] },
    ]);
    expect(r.externalRef).toBe('https://github.com/acme/toy/issues/12#issuecomment-55');
  });

  it('closes the issue with the text as the closing comment for a resolution', async () => {
    const f = fakeGh('', 0, '✓ Closed issue acme/toy#12 (Add dark mode)');
    const r = await new GithubAdapter({ exec: f.exec }).postApproved(
      draft({
        ref: { system: 'github', key: 'acme/toy#12', url: 'https://github.com/acme/toy/issues/12' },
        kind: 'resolution',
        body: 'Done.',
      }),
    );
    expect(f.calls[0]?.args).toEqual(['issue', 'close', '12', '--repo', 'acme/toy', '--comment', 'Done.']);
    expect(r.externalRef).toBe('https://github.com/acme/toy/issues/12');
  });

  it('reports gh failures and a missing gh', async () => {
    const ref = { system: 'github' as const, key: 'acme/toy#12' };
    await expect(
      new GithubAdapter({ exec: fakeGh('', 1, 'HTTP 404: Not Found').exec }).postApproved(draft({ ref })),
    ).rejects.toThrow(/gh issue comment failed: HTTP 404/);
    await expect(
      new GithubAdapter({
        exec: async () => {
          throw Object.assign(new Error('x'), { code: 'ENOENT' });
        },
      }).postApproved(draft({ ref })),
    ).rejects.toThrow(/not installed/);
    await expect(
      new GithubAdapter({ exec: fakeGh().exec }).postApproved(
        draft({ ref: { system: 'github', key: 'nope' } }),
      ),
    ).rejects.toBeInstanceOf(PostError);
  });
});

describe('the outbound executor (the outbound.post command)', () => {
  const executor = (adapters: ExternalAdapters) => new OutboundExecutor({ dir, adapters });

  it('posts once; the same draft again sends nothing and answers with the recorded result', async () => {
    const f = fakeGh('https://github.com/acme/toy/issues/3#issuecomment-1');
    const ex = executor(ExternalAdapters.defaults({ exec: f.exec }));
    const p = payload({ ref: { system: 'github', key: 'acme/toy#3' }, body: 'Hello there.' });
    const first = await ex.run(p);
    expect(first).toEqual({ ok: true, externalRef: 'https://github.com/acme/toy/issues/3#issuecomment-1' });
    const second = await ex.run(p);
    expect(second).toMatchObject({ ok: true, duplicate: true, externalRef: first.externalRef });
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, `${DRAFT}.json`), 'utf8'))).toMatchObject({ state: 'posted' });
    // a restarted runner reads the same record
    expect(await executor(ExternalAdapters.defaults({ exec: f.exec })).run(p)).toMatchObject({
      duplicate: true,
    });
    expect(f.calls).toHaveLength(1);
  });

  it('runs in parallel at most once per draft', async () => {
    const f = fakeGh('https://github.com/acme/toy/issues/3#issuecomment-1');
    const ex = executor(ExternalAdapters.defaults({ exec: f.exec }));
    const p = payload({ ref: { system: 'github', key: 'acme/toy#3' } });
    await Promise.all([ex.run(p), ex.run(p), ex.run(p)]);
    expect(f.calls).toHaveLength(1);
  });

  it('scrubs: a draft that names an agent or internal workings is refused and nothing is posted', async () => {
    const f = fakeGh('x');
    const ex = executor(ExternalAdapters.defaults({ exec: f.exec }));
    const r = await ex.run(
      payload({ ref: { system: 'github', key: 'acme/toy#3' }, body: 'Bea fixed this.', agentNames: ['Bea'] }),
    );
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/refused before posting.*agent name "Bea"/);
    const r2 = await ex.run(
      payload({
        draftId: '019e3f6a-7b1c-7a2d-8c3e-0123456789b2',
        ref: { system: 'github', key: 'acme/toy#3' },
        body: 'It bounced twice in review.',
      }),
    );
    expect(r2.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it('a refusal by the system leaves no record, so a retry posts', async () => {
    pool().intercept({ path: '/rest/api/2/issue/ABC-1/comment', method: 'POST' }).reply(500, 'boom');
    const ex = executor(new ExternalAdapters([jira()]));
    const failed = await ex.run(payload());
    expect(failed).toMatchObject({ ok: false });
    expect(failed.error).toMatch(/Jira answered 500/);
    pool().intercept({ path: '/rest/api/2/issue/ABC-1/comment', method: 'POST' }).reply(201, { id: '5' });
    expect(await ex.run(payload())).toMatchObject({
      ok: true,
      externalRef: expect.stringContaining('focusedCommentId=5'),
    });
  });

  it('after an ambiguous failure it looks for the exact text before posting again', async () => {
    pool()
      .intercept({ path: '/rest/api/2/issue/ABC-1/comment', method: 'POST' })
      .replyWithError(new Error('socket hang up'));
    const ex = executor(new ExternalAdapters([jira()]));
    expect(await ex.run(payload())).toMatchObject({ ok: false });
    // the comment did arrive: the retry finds it and posts nothing
    pool()
      .intercept({ path: /\/rest\/api\/2\/issue\/ABC-1\/comment\?/, method: 'GET' })
      .reply(200, { comments: [{ id: '77', body: 'The export now includes archived items.' }] });
    const again = await ex.run(payload());
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(again.externalRef).toMatch(/focusedCommentId=77$/);
    agent.assertNoPendingInterceptors();
  });

  it('says so when this workstation has no Jira credentials', async () => {
    const r = await executor(new ExternalAdapters([jira(null)])).run(payload());
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/no Jira credentials/);
  });
});
