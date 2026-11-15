import {
  PR_LIST_LIMIT,
  type RepoListMergedPrsPayload,
  type RepoListMergedPrsResult,
  type RepoListPrsPayload,
  type RepoListPrsResult,
} from '@aom/shared';
import { ForgeUnavailableError } from './http.ts';
import { forgeForUrl } from './index.ts';
import type { ForgeEnv } from './types.ts';

/**
 * `repo.list_prs` (PR-only review): the open pull requests of a repository this workstation holds, read with the
 * workstation's own git host login. Read-only; never writes to the repository and never puts a credential in the
 * answer. A missing clone, a git host without support and a missing login are answers, not failures.
 */
export async function listOpenPrs(input: {
  payload: RepoListPrsPayload;
  /** The clone's remote url; null when this workstation has no clone of the repository. */
  remoteUrl: string | null;
  forgeEnv: ForgeEnv;
}): Promise<RepoListPrsResult> {
  const { payload, remoteUrl } = input;
  if (!remoteUrl) return { ok: false, reason: 'no_clone' };
  const hit = forgeForUrl(input.forgeEnv, remoteUrl, payload.forge);
  if (!hit?.forge.listOpenChanges) return { ok: false, reason: 'unsupported' };
  try {
    const { changes, complete } = await hit.forge.listOpenChanges(hit.repo, PR_LIST_LIMIT);
    return { ok: true, complete, changes: changes.slice(0, PR_LIST_LIMIT) };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    if (err instanceof ForgeUnavailableError) return { ok: false, reason: 'not_connected', error: message };
    return { ok: false, reason: 'error', error: message };
  }
}

/** `repo.list_merged_prs` (20-PR replay): the most recently merged pull requests; same answers as `listOpenPrs`. */
export async function listMergedPrs(input: {
  payload: RepoListMergedPrsPayload;
  remoteUrl: string | null;
  forgeEnv: ForgeEnv;
}): Promise<RepoListMergedPrsResult> {
  const { payload, remoteUrl } = input;
  if (!remoteUrl) return { ok: false, reason: 'no_clone' };
  const hit = forgeForUrl(input.forgeEnv, remoteUrl, payload.forge);
  if (!hit?.forge.listMergedChanges) return { ok: false, reason: 'unsupported' };
  try {
    const changes = await hit.forge.listMergedChanges(hit.repo, payload.limit);
    return { ok: true, changes: changes.slice(0, payload.limit) };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    if (err instanceof ForgeUnavailableError) return { ok: false, reason: 'not_connected', error: message };
    return { ok: false, reason: 'error', error: message };
  }
}
