import { type PrReviewNoticePayload, splitNoticeMarker } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { postPrNotice } from '../src/review/notice.ts';
import { GitHubReviewPoster } from '../src/review/review-poster.ts';
import { MemoryReviewerTokenStore } from '../src/review/reviewer-tokens.ts';

const REMOTE = 'github.com/acme/toy';
const TOKEN = 'github_pat_FAKE_pr_notice_0123456789';
const NOTICE = '019e3f6a-7b1c-7a2d-8c3e-0123456789b1';
const payload = (over: Partial<PrReviewNoticePayload> = {}): PrReviewNoticePayload => ({
  noticeId: NOTICE,
  projectRepoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
  remoteUrlNormalized: REMOTE,
  prNumber: 7,
  headSha: 'a'.repeat(40),
  body: `Please split this pull request.\n\n${splitNoticeMarker(NOTICE)}`,
  ...over,
});

interface Call {
  method: string;
  url: string;
  body: any;
}
function host(existing: Array<{ body: string; html_url: string }> = [], postStatus = 200) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') return new Response(JSON.stringify(existing), { status: 200 });
    return new Response(
      JSON.stringify(
        postStatus < 300
          ? { id: 9, html_url: 'https://github.com/acme/toy/pull/7#review-9' }
          : { message: 'no' },
      ),
      { status: postStatus },
    );
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const deps = (h: ReturnType<typeof host>, token = true) => {
  const tokens = new MemoryReviewerTokenStore();
  if (token) tokens.set(REMOTE, TOKEN);
  return { poster: new GitHubReviewPoster({ fetch: h.fetchFn, tokens }) };
};

describe('the split notice is a body-only comment review', () => {
  it('posts one pulls/{n}/reviews with event COMMENT and no inline comments', async () => {
    const h = host();
    const out = await postPrNotice(deps(h), payload());
    expect(out).toEqual({
      ok: true,
      reviewUrl: 'https://github.com/acme/toy/pull/7#review-9',
      alreadyPosted: false,
    });
    const posts = h.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('https://api.github.com/repos/acme/toy/pulls/7/reviews');
    expect(posts[0]?.body).toMatchObject({ event: 'COMMENT', comments: [], commit_id: 'a'.repeat(40) });
    expect(posts[0]?.body.body).toContain(splitNoticeMarker(NOTICE));
  });

  it('omits commit_id when no head is known', async () => {
    const h = host();
    await postPrNotice(deps(h), payload({ headSha: undefined }));
    expect(h.calls.find((c) => c.method === 'POST')?.body).not.toHaveProperty('commit_id');
  });

  it('a review with its marker already on the pull request means no second POST', async () => {
    const h = host([
      { body: `old\n${splitNoticeMarker(NOTICE)}`, html_url: 'https://github.com/acme/toy/pull/7#review-3' },
    ]);
    const out = await postPrNotice(deps(h), payload());
    expect(out).toEqual({
      ok: true,
      reviewUrl: 'https://github.com/acme/toy/pull/7#review-3',
      alreadyPosted: true,
    });
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('maps refusals: 403 is forbidden, 404 not found, no token is no_token, other hosts unsupported', async () => {
    expect(await postPrNotice(deps(host([], 403)), payload())).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(await postPrNotice(deps(host([], 404)), payload())).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(await postPrNotice(deps(host([], 422)), payload())).toMatchObject({ ok: false, code: 'error' });
    expect(await postPrNotice(deps(host(), false), payload())).toMatchObject({ ok: false, code: 'no_token' });
    expect(
      await postPrNotice(deps(host()), payload({ remoteUrlNormalized: 'gitlab.com/acme/toy' })),
    ).toMatchObject({
      ok: false,
    });
  });

  it('never puts the token in an answer', async () => {
    const out = await postPrNotice(deps(host([], 403)), payload());
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});
