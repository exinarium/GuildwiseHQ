import { parseRemote, type ReviewFinding } from '@aom/shared';
import { redact } from '../secrets/redact.ts';
import type { ReviewerRun } from './reviewer-sandbox.ts';
import type { ReviewerTokenStore } from './reviewer-tokens.ts';

/** Why a review could not be posted. `message` never holds the token. */
export class ReviewPostError extends Error {
  constructor(
    readonly code: 'reviewer_token_missing' | 'unsupported_host' | 'rejected' | 'unreachable',
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ReviewPoster {
  post(
    run: Pick<ReviewerRun, 'spec'>,
    findings: ReviewFinding[],
    summary: string,
  ): Promise<{ reviewId: string; url: string }>;
}

/** The REST base of a GitHub host: api.github.com, or `<host>/api/v3` for GitHub Enterprise Server. */
export function githubApiBase(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

const findingText = (f: ReviewFinding): string => `**${f.title}**\n\n${f.body}`;

const whereOf = (f: ReviewFinding): string => (f.path ? `\`${f.path}${f.line ? `:${f.line}` : ''}\`: ` : '');

/**
 * Posts findings as ONE pull request review with the event hard-coded to COMMENT, so a review can never approve,
 * request changes or merge. The runner posts, never the agent: the token comes from the reviewer store at post time and
 * goes into one HTTPS header. There is no fallback to `gh`, to the owner's git login or to any environment variable.
 */
export class GitHubReviewPoster implements ReviewPoster {
  constructor(private readonly env: { fetch: typeof fetch; tokens: ReviewerTokenStore }) {}

  async post(run: Pick<ReviewerRun, 'spec'>, findings: ReviewFinding[], summary: string) {
    const { spec } = run;
    const token = this.env.tokens.get(spec.remoteUrlNormalized)?.token;
    if (!token)
      throw new ReviewPostError('reviewer_token_missing', 'no reviewer token is saved for this repository');
    const remote = parseRemote(spec.remoteUrlNormalized);
    if (!remote || remote.kind !== 'github')
      throw new ReviewPostError('unsupported_host', 'reviews can only be posted to GitHub');
    const url = `${githubApiBase(remote.host)}/repos/${remote.namespace.join('/')}/${remote.name.replace(/\.git$/i, '')}/pulls/${spec.prNumber}/reviews`;

    const withLines = {
      commit_id: spec.headSha,
      event: 'COMMENT' as const,
      body: summary,
      comments: findings
        .filter((f) => f.path && f.line)
        .map((f) => ({
          path: f.path as string,
          line: f.line as number,
          side: f.side ?? 'RIGHT',
          body: findingText(f),
        })),
    };
    // findings with no line go into the summary
    const loose = findings.filter((f) => !(f.path && f.line));
    if (loose.length)
      withLines.body = [summary, ...loose.map((f) => `- ${whereOf(f)}${findingText(f)}`)]
        .filter(Boolean)
        .join('\n\n');

    let res = await this.send(url, token, withLines);
    if (res.status === 422 && withLines.comments.length > 0) {
      // a line outside the diff makes the host refuse the whole review: post the same findings in the body, once
      const inBody = {
        commit_id: spec.headSha,
        event: 'COMMENT' as const,
        body: [summary, ...findings.map((f) => `- ${whereOf(f)}${findingText(f)}`)]
          .filter(Boolean)
          .join('\n\n'),
        comments: [],
      };
      res = await this.send(url, token, inBody);
    }
    if (!res.ok) {
      const text = redact((await res.text().catch(() => '')).slice(0, 300));
      throw new ReviewPostError(
        'rejected',
        `the host answered ${res.status}${text ? `: ${text}` : ''}`,
        res.status,
      );
    }
    const out = (await res.json().catch(() => ({}))) as { id?: number | string; html_url?: string };
    return { reviewId: String(out.id ?? ''), url: out.html_url ?? '' };
  }

  private async send(url: string, token: string, body: unknown): Promise<Response> {
    try {
      return await this.env.fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ReviewPostError('unreachable', redact(err instanceof Error ? err.message : String(err)));
    }
  }
}
