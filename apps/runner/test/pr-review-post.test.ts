import { type PrReviewPostPayload, prReviewMarker } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { postPrReview } from '../src/review/post.ts';
import { GitHubReviewPoster } from '../src/review/review-poster.ts';
import { MemoryReviewerTokenStore } from '../src/review/reviewer-tokens.ts';

const REMOTE = 'github.com/acme/toy';
const TOKEN = 'github_pat_FAKE_pr_review_0123456789';
const RUN = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const spec = {
  runId: RUN,
  projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
  projectRepoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
  remoteUrlNormalized: REMOTE,
  prNumber: 7,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  baseRef: 'main',
};
const payload = (): PrReviewPostPayload => ({
  runId: RUN,
  spec,
  summary: `Two things to look at.\n\n${prReviewMarker(RUN)}`,
  findings: [
    {
      findingId: '019e3f6a-7b1c-7a2d-8c3e-0123456789f1',
      finding: { path: 'a.ts', line: 2, side: 'RIGHT', title: '[high] Null deref', body: 'x may be null' },
    },
    {
      findingId: '019e3f6a-7b1c-7a2d-8c3e-0123456789f2',
      finding: { path: 'a.ts', line: 3, side: 'RIGHT', title: '[low] Odd name', body: 'rename' },
    },
    {
      findingId: '019e3f6a-7b1c-7a2d-8c3e-0123456789f3',
      finding: { path: 'b.ts', title: '[medium] Missing test', body: 'line 99, outside the diff' },
    },
  ],
});

interface Call {
  method: string;
  url: string;
  body: any;
  auth: string | undefined;
}
/** A fake host: `existing` are the reviews already on the pull request; the POST statuses answer in order. */
function host(
  existing: Array<{ body: string; html_url: string }> = [],
  statuses: number[] = [200],
  getStatus = 200,
) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({
      method,
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init.headers as Record<string, string>).Authorization,
    });
    if (method === 'GET') return new Response(JSON.stringify(existing), { status: getStatus });
    const n = calls.filter((c) => c.method === 'POST').length;
    const status = statuses[Math.min(n - 1, statuses.length - 1)] as number;
    return new Response(
      JSON.stringify(
        status < 300
          ? { id: 5, html_url: 'https://github.com/acme/toy/pull/7#review-5' }
          : { message: `no ${TOKEN}` },
      ),
      { status },
    );
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const poster = (h: ReturnType<typeof host>, token = true) => {
  const tokens = new MemoryReviewerTokenStore();
  if (token) tokens.set(REMOTE, TOKEN);
  return { poster: new GitHubReviewPoster({ fetch: h.fetchFn, tokens }) };
};

describe('AC1: the findings of a completed run are posted as one review', () => {
  it('checks for its own review, then makes exactly one POST with the inline comments and the marker', async () => {
    const h = host();
    const out = await postPrReview(poster(h), payload());
    expect(out).toEqual({
      ok: true,
      reviewUrl: 'https://github.com/acme/toy/pull/7#review-5',
      alreadyPosted: false,
    });
    expect(h.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    const post = h.calls[1] as Call;
    expect(post.url).toBe('https://api.github.com/repos/acme/toy/pulls/7/reviews');
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
    expect(post.body.event).toBe('COMMENT');
    expect(post.body.commit_id).toBe(spec.headSha);
    expect(post.body.comments).toHaveLength(2);
    expect(post.body.comments.map((c: any) => c.line)).toEqual([2, 3]);
    expect(post.body.body).toContain(prReviewMarker(RUN));
    expect(post.body.body).toContain('Missing test');
    // blind marking: the review never says which model or which reviewer slot wrote it
    expect(JSON.stringify(post.body).toLowerCase()).not.toMatch(/sonnet|opus|claude|first reviewer/);
  });

  it('a finding without a line cannot make the host refuse the inline comments (no 422 retry)', async () => {
    const h = host();
    await postPrReview(poster(h), payload());
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('a repeated post command', () => {
  it('finds its review by the marker and posts nothing again', async () => {
    const h = host([
      { body: 'someone else', html_url: 'https://x/other' },
      { body: `Two things.\n${prReviewMarker(RUN)}`, html_url: 'https://x/mine' },
    ]);
    const out = await postPrReview(poster(h), payload());
    expect(out).toEqual({ ok: true, reviewUrl: 'https://x/mine', alreadyPosted: true });
    expect(h.calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('AC4: a post that fails says why and leaves nothing partial', () => {
  it('no token: no request at all', async () => {
    const h = host();
    expect(await postPrReview(poster(h, false), payload())).toMatchObject({ ok: false, code: 'no_token' });
    expect(h.calls).toHaveLength(0);
  });
  it('the host refusing the token is forbidden, and the answer never holds the token', async () => {
    const h = host([], [403]);
    const out = await postPrReview(poster(h), payload());
    expect(out).toMatchObject({ ok: false, code: 'forbidden' });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
  it('a pull request that is gone is not_found; a head that moved (422 even in the body) is stale_head', async () => {
    expect(await postPrReview(poster(host([], [404])), payload())).toMatchObject({ code: 'not_found' });
    const h = host([], [422, 422]);
    expect(await postPrReview(poster(h), payload())).toMatchObject({ ok: false, code: 'stale_head' });
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });
  it('an unreachable host and a server error are reported, not thrown', async () => {
    const down = {
      poster: new GitHubReviewPoster({
        fetch: (async () => {
          throw new Error(`connect ${TOKEN}`);
        }) as never,
        tokens: (() => {
          const t = new MemoryReviewerTokenStore();
          t.set(REMOTE, TOKEN);
          return t;
        })(),
      }),
    };
    const out = await postPrReview(down, payload());
    expect(out).toMatchObject({ ok: false, code: 'unreachable' });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(await postPrReview(poster(host([], [500])), payload())).toMatchObject({
      ok: false,
      code: 'error',
    });
  });
});
