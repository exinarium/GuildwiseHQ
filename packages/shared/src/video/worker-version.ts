import { compareSemver } from '../repo/component-rules.ts';

/** The header a render worker sends with every artifact push. */
export const WORKER_VERSION_HEADER = 'x-worker-version';
/** The error code of a push refused because the worker is older than the server. */
export const WORKER_OUTDATED_CODE = 'worker_outdated';
/** SQL LIKE pattern matching workerOutdatedMessage (the error a refused push leaves on the render row). */
export const WORKER_OUTDATED_LIKE = 'video worker % is older than server %';

/** A version as reported: trimmed, at most 60 characters of [0-9A-Za-z.+-]; anything else is "no version". */
export function cleanWorkerVersion(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^[0-9A-Za-z.+-]{1,60}$/.test(s) ? s : null;
}

/**
 * Outdated = the worker is older than the server. A missing or non-semver worker version counts as older. When the
 * server's own version is unknown (null or not semver), nothing can be compared and no worker is outdated.
 */
export function workerOutdated(worker: string | null | undefined, server: string | null | undefined): boolean {
  if (!server || compareSemver(server, server) === null) return false;
  if (!worker) return true;
  const c = compareSemver(worker, server);
  return c === null || c < 0;
}

/** The error an outdated worker gets: names both versions and what to do. */
export function workerOutdatedMessage(worker: string | null | undefined, server: string): string {
  return `video worker ${worker || '(no version)'} is older than server ${server}; update the worker`;
}
