import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { WORKER_VERSION_HEADER } from '@aom/shared';

/**
 * The remote render worker's side of the artifact push (video/push.ts): PUT each finished file to the signed upload link
 * the claim handed out (`/api/worker/video/renders/<renderId>/files/<name>?attempt&exp&sig`), with the worker's own
 * bearer token and the file's sha256, retrying with backoff. Resolves only when every file is acknowledged (HTTP 2xx);
 * throws otherwise, and the render then stays unfinished.
 */

export interface PushDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Waits between attempts of one file (default 2 s, 10 s, 30 s, 90 s: five attempts). */
  backoffMs?: number[];
}

export interface PushTarget {
  /** The full upload URL of this file (the signed link resolved against the server URL). */
  url: string;
  /** The render worker's bearer token. */
  token: string;
  /** The worker's application version, sent with each file; the server refuses files from a worker older than itself. */
  version?: string | null;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest('hex');
}

class PushRefused extends Error {}

export async function pushFile(target: PushTarget, path: string, deps: PushDeps = {}): Promise<void> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const waits = deps.backoffMs ?? [2_000, 10_000, 30_000, 90_000];
  const name = basename(path);
  const url = target.url;
  const size = (await stat(path)).size;
  const sha = await sha256File(path);
  let last = '';
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    if (attempt > 0) await sleep(waits[attempt - 1] as number);
    try {
      const res = await doFetch(url, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${target.token}`,
          'x-content-sha256': sha,
          'content-length': String(size),
          'content-type': 'application/octet-stream',
          ...(target.version ? { [WORKER_VERSION_HEADER]: target.version } : {}),
        },
        body: createReadStream(path),
        duplex: 'half', // a streamed request body
      } as unknown as RequestInit);
      if (res.ok) return;
      last = `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`;
      // 4xx other than a timeout/rate limit will not get better by waiting
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
        throw new PushRefused(`push of ${name} refused: ${last}`);
    } catch (err) {
      if (err instanceof PushRefused) throw err;
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`push of ${name} failed after ${waits.length + 1} attempts: ${last}`);
}

/** Pushes every file in turn (the video last: the small files are cheap to repeat). `urlOf` gives each file's link. */
export async function pushArtifacts(
  target: Omit<PushTarget, 'url'> & { urlOf: (name: string) => string },
  paths: string[],
  deps: PushDeps = {},
): Promise<void> {
  const ordered = [...paths].sort((a, b) => Number(/\.mp4$/.test(a)) - Number(/\.mp4$/.test(b)));
  for (const p of ordered)
    await pushFile({ url: target.urlOf(basename(p)), token: target.token, version: target.version }, p, deps);
}
