import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * The render worker's side of the artifact push (video/push.ts): PUT each finished file to
 * `<base>/api/worker/video/renders/<renderId>/files/<name>` with its sha256, retrying with backoff. Resolves only when
 * every file is acknowledged (HTTP 2xx); throws otherwise, and the render then stays unfinished.
 */

export interface PushDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Waits between attempts of one file (default 2 s, 10 s, 30 s, 90 s: five attempts). */
  backoffMs?: number[];
}

export interface PushTarget {
  baseUrl: string;
  token: string;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest('hex');
}

class PushRefused extends Error {}

export async function pushFile(
  target: PushTarget,
  renderId: string,
  path: string,
  deps: PushDeps = {},
): Promise<void> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const waits = deps.backoffMs ?? [2_000, 10_000, 30_000, 90_000];
  const name = basename(path);
  const url = `${target.baseUrl.replace(/\/+$/, '')}/api/worker/video/renders/${encodeURIComponent(renderId)}/files/${encodeURIComponent(name)}`;
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

/** Pushes every file in turn (the video last: the small files are cheap to repeat). */
export async function pushArtifacts(
  target: PushTarget,
  renderId: string,
  paths: string[],
  deps: PushDeps = {},
): Promise<void> {
  const ordered = [...paths].sort((a, b) => Number(/\.mp4$/.test(a)) - Number(/\.mp4$/.test(b)));
  for (const p of ordered) await pushFile(target, renderId, p, deps);
}
