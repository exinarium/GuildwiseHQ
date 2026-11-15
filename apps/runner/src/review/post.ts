import { type PrReviewPostPayload, type PrReviewPostResult, prReviewMarker } from '@aom/shared';
import { type GitHubReviewPoster, ReviewPostError } from './review-poster.ts';

export interface PrReviewPostDeps {
  poster: Pick<GitHubReviewPoster, 'post' | 'findByMarker'>;
}

const short = (s: string): string => s.slice(0, 400);

/**
 * Posts the findings of one completed run as ONE review, with the comment-only token. Only called for a run the
 * server marked completed. A repeated command (a resend after a reconnect) finds its own review by the run marker and
 * answers with it instead of posting again.
 */
export async function postPrReview(
  deps: PrReviewPostDeps,
  payload: PrReviewPostPayload,
): Promise<PrReviewPostResult> {
  try {
    const existing = await deps.poster.findByMarker(payload.spec, prReviewMarker(payload.runId));
    if (existing !== null) return { ok: true, reviewUrl: existing.slice(0, 500), alreadyPosted: true };
    const posted = await deps.poster.post(
      { spec: payload.spec },
      payload.findings.map((f) => f.finding),
      payload.summary,
    );
    return { ok: true, reviewUrl: posted.url.slice(0, 500), alreadyPosted: false };
  } catch (err) {
    if (err instanceof ReviewPostError) {
      const error = short(err.message);
      switch (err.code) {
        case 'reviewer_token_missing':
          return { ok: false, code: 'no_token', error };
        case 'unsupported_host':
          return { ok: false, code: 'unsupported', error };
        case 'unreachable':
          return { ok: false, code: 'unreachable', error };
        default:
          if (err.status === 401 || err.status === 403) return { ok: false, code: 'forbidden', error };
          if (err.status === 404) return { ok: false, code: 'not_found', error };
          if (err.status === 422) return { ok: false, code: 'stale_head', error };
          return { ok: false, code: 'error', error };
      }
    }
    return { ok: false, code: 'error', error: short(err instanceof Error ? err.message : String(err)) };
  }
}
