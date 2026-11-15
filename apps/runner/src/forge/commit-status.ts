import type { RepoCommitStatusPayload, RepoCommitStatusResult } from '@aom/shared';
import { forgeForUrl } from './index.ts';
import type { ForgeEnv } from './types.ts';

/**
 * `repo.commit_status` (the hard size check): sets a commit status on the repository's git host with the size check
 * status token. A missing clone and a git host without support are answers, not failures. No token reaches the answer.
 */
export async function postCommitStatus(input: {
  payload: RepoCommitStatusPayload;
  /** The clone's remote url; null when this workstation has no clone of the repository. */
  remoteUrl: string | null;
  forgeEnv: ForgeEnv;
}): Promise<RepoCommitStatusResult> {
  const { payload, remoteUrl } = input;
  if (!remoteUrl)
    return { ok: false, code: 'no_clone', error: 'this workstation has no clone of the repository' };
  const hit = forgeForUrl(input.forgeEnv, remoteUrl, payload.forge);
  if (!hit?.forge.setCommitStatus)
    return {
      ok: false,
      code: 'unsupported',
      error: 'this git host cannot receive a commit status from here',
    };
  try {
    const r = await hit.forge.setCommitStatus(hit.repo, {
      sha: payload.sha,
      state: payload.state,
      context: payload.context,
      description: payload.description,
      ...(payload.targetUrl ? { targetUrl: payload.targetUrl } : {}),
    });
    return r.ok ? { ok: true } : { ok: false, code: r.code, error: r.error.slice(0, 400) };
  } catch (err) {
    return {
      ok: false,
      code: 'error',
      error: (err instanceof Error ? err.message : String(err)).slice(0, 400),
    };
  }
}

/** Runs one task per key at a time: a resent command for a post that is still live shares its answer. */
export class LiveOnce<T = RepoCommitStatusResult> {
  private readonly live = new Map<string, Promise<T>>();
  once(key: string, run: () => Promise<T>): Promise<T> {
    const hit = this.live.get(key);
    if (hit) return hit;
    const p = run().finally(() => this.live.delete(key));
    this.live.set(key, p);
    return p;
  }
}
