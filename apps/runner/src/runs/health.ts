import { createConnection } from 'node:net';

/** One health probe. Never throws; `detail` says why it failed. */
export async function probeHttp(
  url: string,
  expect: '2xx' | '2xx3xx',
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => undefined);
    const ok = res.status >= 200 && (expect === '2xx3xx' ? res.status < 400 : res.status < 300);
    return ok ? { ok } : { ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function probeTcp(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 2000,
): Promise<{ ok: boolean; detail?: string }> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host });
    const done = (ok: boolean, detail?: string) => {
      s.destroy();
      resolve(detail ? { ok, detail } : { ok });
    };
    s.setTimeout(timeoutMs, () => done(false, 'timed out'));
    s.once('connect', () => done(true));
    s.once('error', (err) => done(false, err.message));
  });
}
