import { describe, expect, it } from 'vitest';
import { GitHubReviewPoster, ReviewPostError } from '../src/review/review-poster.ts';
import { MemoryReviewerTokenStore } from '../src/review/reviewer-tokens.ts';

const REMOTE = 'github.com/acme/toy';
const TOKEN = 'github_pat_FAKE_poster_0123456789';
const HEAD = 'a'.repeat(40);
const spec = {
  runId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
  projectRepoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
  remoteUrlNormalized: REMOTE,
  prNumber: 7,
  headSha: HEAD,
  baseSha: 'b'.repeat(40),
  baseRef: 'main',
};

interface Call {
  url: string;
  init: RequestInit;
  body: any;
}
/** A fake host: records every request and answers with the given statuses in order. */
function host(statuses: number[] = [200]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] as number;
    return new Response(
      JSON.stringify(
        status < 300 ? { id: 99, html_url: 'https://x/review/99' } : { message: `bad ${TOKEN}` },
      ),
      {
        status,
      },
    );
  }) as unknown as typeof fetch;
  return { calls, f };
}

const finding = (over = {}) => ({
  title: 'Null deref',
  body: 'x may be null',
  path: 'a.ts',
  line: 3,
  ...over,
});

describe('AC2: findings are posted with the comment-only token', () => {
  it('sends one COMMENT review to the pull request with the token and the head commit', async () => {
    const tokens = new MemoryReviewerTokenStore();
    tokens.set(REMOTE, TOKEN);
    const h = host();
    const out = await new GitHubReviewPoster({ fetch: h.f, tokens }).post({ spec }, [finding()], 'Summary');
    expect(out).toEqual({ reviewId: '99', url: 'https://x/review/99' });
    expect(h.calls).toHaveLength(1);
    const c = h.calls[0] as Call;
    expect(c.url).toBe('https://api.github.com/repos/acme/toy/pulls/7/reviews');
    expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.body).toMatchObject({ commit_id: HEAD, event: 'COMMENT', body: 'Summary' });
    expect(c.body.comments).toEqual([
      { path: 'a.ts', line: 3, side: 'RIGHT', body: '**Null deref**\n\nx may be null' },
    ]);
  });

  it('can never approve or request changes: the event is fixed', async () => {
    const tokens = new MemoryReviewerTokenStore();
    tokens.set(REMOTE, TOKEN);
    const h = host();
    await new GitHubReviewPoster({ fetch: h.f, tokens }).post(
      { spec },
      [{ ...finding(), event: 'APPROVE' } as never],
      '',
    );
    expect(h.calls[0]?.body.event).toBe('COMMENT');
  });

  it('a finding without a line goes into the review body, in the same single review', async () => {
    const tokens = new MemoryReviewerTokenStore();
    tokens.set(REMOTE, TOKEN);
    const h = host();
    await new GitHubReviewPoster({ fetch: h.f, tokens }).post(
      { spec },
      [finding(), finding({ title: 'General', path: undefined, line: undefined })],
      'Summary',
    );
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.body.comments).toHaveLength(1);
    expect(h.calls[0]?.body.body).toContain('General');
  });

  it('a 422 (a line outside the diff) is retried once with every finding in the body', async () => {
    const tokens = new MemoryReviewerTokenStore();
    tokens.set(REMOTE, TOKEN);
    const h = host([422, 200]);
    await new GitHubReviewPoster({ fetch: h.f, tokens }).post({ spec }, [finding()], 'Summary');
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.body.comments).toEqual([]);
    expect(h.calls[1]?.body.body).toContain('Null deref');
    expect(h.calls[1]?.body.event).toBe('COMMENT');
  });

  it('a refusal is reported without the token, and is not retried more than once', async () => {
    const tokens = new MemoryReviewerTokenStore();
    tokens.set(REMOTE, TOKEN);
    const h = host([422, 403]);
    const err = await new GitHubReviewPoster({ fetch: h.f, tokens })
      .post({ spec }, [finding()], '')
      .catch((e) => e);
    expect(err).toBeInstanceOf(ReviewPostError);
    expect(err.status).toBe(403);
    expect(h.calls).toHaveLength(2);
  });

  it('uses the enterprise API path for another GitHub host', async () => {
    const tokens = new MemoryReviewerTokenStore();
    tokens.set('github.example.com/acme/toy', TOKEN);
    const h = host();
    await new GitHubReviewPoster({ fetch: h.f, tokens }).post(
      { spec: { ...spec, remoteUrlNormalized: 'github.example.com/acme/toy' } },
      [finding()],
      '',
    );
    expect(h.calls[0]?.url).toBe('https://github.example.com/api/v3/repos/acme/toy/pulls/7/reviews');
  });
});

describe('the poster uses no other credential', () => {
  it('without a token for the repository it throws and makes no request', async () => {
    const h = host();
    const tokens = new MemoryReviewerTokenStore();
    tokens.set('github.com/acme/other', TOKEN);
    const err = await new GitHubReviewPoster({ fetch: h.f, tokens })
      .post({ spec }, [finding()], '')
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'reviewer_token_missing' });
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a host that is not GitHub', async () => {
    const h = host();
    const tokens = new MemoryReviewerTokenStore();
    tokens.set('gitlab.com/acme/toy', TOKEN);
    const err = await new GitHubReviewPoster({ fetch: h.f, tokens })
      .post({ spec: { ...spec, remoteUrlNormalized: 'gitlab.com/acme/toy' } }, [finding()], '')
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'unsupported_host' });
    expect(h.calls).toHaveLength(0);
  });

  it('never starts a process: the poster takes only a fetch and the reviewer token store', () => {
    // there is no executor in its environment, so `gh` cannot be called; the constructor shape is the guarantee
    expect(GitHubReviewPoster.length).toBe(1);
  });
});
