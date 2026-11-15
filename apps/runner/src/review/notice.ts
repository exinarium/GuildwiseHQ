import {
  APP_IDENTITY_FAILED_CODE,
  type PrReviewNoticePayload,
  type PrReviewNoticeResult,
  splitNoticeMarker,
} from '@aom/shared';
import { type GitHubReviewPoster, ReviewPostError } from './review-poster.ts';

export interface PrNoticeDeps {
  poster: Pick<GitHubReviewPoster, 'post' | 'findByMarker'>;
}

const short = (s: string): string => s.slice(0, 400);

/**
 * Tells the author of a pull request that is over the size budget to split it: ONE body-only comment review, posted with
 * the comment-only reviewer token (it can never approve or block). A repeated command (a resend after a reconnect) finds
 * its own review by the hidden marker and answers with it instead of posting again. Never uses `gh` or the owner's login.
 */
export async function postPrNotice(
  deps: PrNoticeDeps,
  payload: PrReviewNoticePayload,
): Promise<PrReviewNoticeResult> {
  const target = {
    remoteUrlNormalized: payload.remoteUrlNormalized,
    prNumber: payload.prNumber,
    ...(payload.headSha ? { headSha: payload.headSha } : {}),
  };
  try {
    const existing = await deps.poster.findByMarker(target, splitNoticeMarker(payload.noticeId));
    if (existing !== null) return { ok: true, reviewUrl: existing.slice(0, 500), alreadyPosted: true };
    const posted = await deps.poster.post({ spec: target }, [], payload.body);
    return { ok: true, reviewUrl: posted.url.slice(0, 500), alreadyPosted: false };
  } catch (err) {
    if (err instanceof ReviewPostError) {
      const error = short(err.message);
      if (err.message.startsWith(`${APP_IDENTITY_FAILED_CODE}:`))
        return { ok: false, code: 'app_identity_failed', error };
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
          return { ok: false, code: 'error', error };
      }
    }
    return { ok: false, code: 'error', error: short(err instanceof Error ? err.message : String(err)) };
  }
}
