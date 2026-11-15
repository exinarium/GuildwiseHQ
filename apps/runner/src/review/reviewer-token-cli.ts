import { parseRemote } from '@aom/shared';
import { githubApiBase } from './review-poster.ts';
import type { ReviewerTokenStore } from './reviewer-tokens.ts';

export type SetReviewerTokenResult = { ok: true } | { ok: false; error: string };

const WRITE_SCOPE = /^(repo|public_repo|admin:.*|write:.*|delete_repo)$/;

/**
 * Checks a reviewer token against its repository and saves it. The token is never written anywhere but the sealed store.
 * A classic PAT that carries a write scope is refused; a fine-grained token cannot be inspected, so the guards for it are
 * the Read-role bot account (docs/RUNNER.md) and the fact that only the reviews endpoint is ever called.
 */
export async function setReviewerToken(input: {
  store: ReviewerTokenStore;
  remoteUrl: string;
  token: string;
  fetch: typeof fetch;
}): Promise<SetReviewerTokenResult> {
  const { store, remoteUrl, token } = input;
  const remote = parseRemote(remoteUrl);
  if (!remote) return { ok: false, error: 'not a usable repository url' };
  if (remote.kind !== 'github') return { ok: false, error: 'reviewer tokens are supported for GitHub only' };
  if (!token) return { ok: false, error: 'no token entered' };
  let res: Response;
  try {
    res = await input.fetch(
      `${githubApiBase(remote.host)}/repos/${remote.namespace.join('/')}/${remote.name.replace(/\.git$/i, '')}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
  } catch {
    return { ok: false, error: 'the git host could not be reached' };
  }
  if (res.status !== 200)
    return { ok: false, error: `the host does not accept this token for the repository (${res.status})` };
  const scopes = (res.headers.get('x-oauth-scopes') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (scopes.some((s) => WRITE_SCOPE.test(s)))
    return {
      ok: false,
      error:
        'this token can write to the repository. Use a fine-grained token: Pull requests read and write, Contents read, Metadata read',
    };
  store.set(remoteUrl, token);
  return { ok: true };
}

/** `status` lines: which repositories have a token, never the value. */
export function reviewerTokenStatusLines(store: ReviewerTokenStore, remoteUrl?: string): string[] {
  const problem = store.problem();
  if (problem) return [problem];
  if (remoteUrl) return [`${remoteUrl}: ${store.has(remoteUrl) ? 'present' : 'missing'}`];
  const l = store.list();
  return l.length ? l.map((t) => `${t.remote}: present (saved ${t.savedAt})`) : ['no reviewer tokens saved'];
}
