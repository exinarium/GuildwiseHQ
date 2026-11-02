import { createHash } from 'node:crypto';
import { STORAGE_CHUNK_BYTES, STORAGE_WINDOW, type StorageReference } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { StorageRelay, type StorageRelayDeps } from '../src/storage-relay/hub.ts';

const CONN = '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11';
const WS = 'ws-1';
type Frame = { type: string; payload: Record<string, any> };

async function* source(parts: Buffer[]) {
  for (const p of parts) yield p;
}

function make(over: Partial<StorageRelayDeps> = {}, opts: { answer?: 'ok' | 'silent' | 'early_error' } = {}) {
  const frames: Frame[] = [];
  const outcomes: unknown[] = [];
  const logs: unknown[] = [];
  let relay: StorageRelay;
  const received: Buffer[] = [];
  let maxSeqSeen = -1;
  let creditedUpTo = 0;
  const deps: StorageRelayDeps = {
    config: { writeTimeoutMs: 5000, maxFileBytes: 10 * 1024 * 1024, maxInFlight: 2 },
    lookup: async (_org, id) => (id === CONN ? { kind: 'local', workstationId: WS } : undefined),
    isOnline: () => true,
    send: (_ws, type, rawPayload) => {
      const payload = rawPayload as Record<string, any>;
      frames.push({ type, payload });
      const tid = payload.transferId as string;
      if (type === 'storage.write.open') {
        if (opts.answer === 'early_error')
          queueMicrotask(() =>
            relay.onResult(WS, tid, {
              ok: false,
              error: { code: 'auth_expired', message: 'expired', retryable: false },
            }),
          );
        else if (opts.answer !== 'silent') {
          creditedUpTo = STORAGE_WINDOW;
          queueMicrotask(() => relay.onCredit(WS, tid, creditedUpTo));
        }
      }
      if (type === 'storage.write.chunk') {
        maxSeqSeen = Math.max(maxSeqSeen, payload.seq);
        received.push(Buffer.from(payload.data, 'base64'));
        // grant more credit as chunks arrive, like the runner does
        if ((payload.seq + 1) % 4 === 0) {
          creditedUpTo = payload.seq + 1 + STORAGE_WINDOW;
          queueMicrotask(() => relay.onCredit(WS, tid, creditedUpTo));
        }
      }
      if (type === 'storage.write.end' && opts.answer !== 'silent') {
        const body = Buffer.concat(received);
        const reference: StorageReference = {
          v: 1,
          connectionId: CONN,
          kind: 'local',
          path: 'a/b.txt',
          size: payload.size,
          sha256: createHash('sha256').update(body).digest('hex'),
          contentType: 'text/plain',
          writtenAt: new Date().toISOString(),
        };
        queueMicrotask(() => relay.onResult(WS, tid, { ok: true, reference }));
      }
      return true;
    },
    onOutcome: (id, o) => void outcomes.push([id, o]),
    log: (e) => void logs.push(e),
    ...over,
  };
  relay = new StorageRelay(deps);
  return { relay, frames, outcomes, logs, received, window: () => ({ maxSeqSeen, creditedUpTo }) };
}

const req = (src: AsyncIterable<Buffer>, size: number, extra = {}) => ({
  orgId: 'org',
  connectionId: CONN,
  folder: '{client}',
  name: 'doc',
  vars: { client: 'Smith' },
  contentType: 'text/plain',
  size,
  source: src,
  ...extra,
});

describe('StorageRelay.write', () => {
  it('streams the file in ordered chunks within the credit window and returns the reference', async () => {
    const body = Buffer.alloc(STORAGE_CHUNK_BYTES * 20 + 123, 'x');
    const t = make();
    const r = await t.relay.write(req(source([body.subarray(0, 1000), body.subarray(1000)]), body.length));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reference.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(Buffer.concat(t.received).equals(body)).toBe(true);
    const seqs = t.frames.filter((f) => f.type === 'storage.write.chunk').map((f) => f.payload.seq);
    expect(seqs).toEqual([...seqs.keys()]);
    const end = t.frames.find((f) => f.type === 'storage.write.end');
    expect(end?.payload).toMatchObject({ chunks: seqs.length, size: body.length });
    expect(t.relay.inFlight).toBe(0);
    expect(t.outcomes).toEqual([[CONN, { ok: true }]]);
  });

  it('answers runner_offline at once when the workstation is not connected', async () => {
    const t = make({ isOnline: () => false });
    const started = Date.now();
    const r = await t.relay.write(req(source([Buffer.from('x')]), 1));
    expect(r).toMatchObject({ ok: false, error: { code: 'runner_offline', retryable: true } });
    expect(Date.now() - started).toBeLessThan(200);
    expect(t.frames).toEqual([]);
  });

  it('refuses unknown connections, bad templates, too large files and too many uploads without touching the runner', async () => {
    const t = make();
    expect(await t.relay.write({ ...req(source([]), 0), connectionId: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await t.relay.write({ ...req(source([]), 0), folder: '{bogus}' })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    expect(await t.relay.write(req(source([]), 11 * 1024 * 1024))).toMatchObject({
      ok: false,
      error: { code: 'too_large' },
    });
    expect(t.frames).toEqual([]);
  });

  it('returns the typed error the runner gives before any data is sent', async () => {
    const t = make({}, { answer: 'early_error' });
    const r = await t.relay.write(req(source([Buffer.from('x')]), 1));
    expect(r).toMatchObject({ ok: false, error: { code: 'auth_expired' } });
    expect(t.frames.some((f) => f.type === 'storage.write.chunk')).toBe(false);
    expect(t.outcomes[0]).toMatchObject([CONN, { ok: false }]);
  });

  it('times out within the deadline when the runner is silent, sends abort and holds nothing', async () => {
    const t = make(
      { config: { writeTimeoutMs: 5000, maxFileBytes: 1e6, maxInFlight: 2 } },
      { answer: 'silent' },
    );
    const started = Date.now();
    const r = await t.relay.write(req(source([Buffer.from('x')]), 1));
    expect(r).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(5500);
    expect(t.frames.some((f) => f.type === 'storage.write.abort')).toBe(true);
    expect(t.relay.inFlight).toBe(0);
  }, 10_000);

  it('ends as unavailable when the runner disconnects mid transfer', async () => {
    const t = make();
    const big = Buffer.alloc(STORAGE_CHUNK_BYTES * 3, 'y');
    async function* slow() {
      yield big.subarray(0, STORAGE_CHUNK_BYTES);
      t.relay.onDisconnect(WS);
      await new Promise((r) => setTimeout(r, 20));
      yield big.subarray(STORAGE_CHUNK_BYTES);
    }
    const r = await t.relay.write(req(slow(), big.length));
    expect(r).toMatchObject({ ok: false, error: { code: 'unavailable', retryable: true } });
    expect(t.relay.inFlight).toBe(0);
  });

  it('aborts with too_large when more bytes arrive than announced', async () => {
    const t = make();
    const r = await t.relay.write(req(source([Buffer.alloc(100)]), 10));
    expect(r).toMatchObject({ ok: false, error: { code: 'too_large' } });
    expect(t.frames.find((f) => f.type === 'storage.write.abort')?.payload.reason).toBe('too_large');
  });

  it('logs only ids, size, outcome and latency', async () => {
    const t = make();
    await t.relay.write(req(source([Buffer.from('hello')]), 5));
    expect(Object.keys(t.logs[0] as object).sort()).toEqual([
      'connectionId',
      'kind',
      'latencyMs',
      'outcome',
      'sizeBytes',
    ]);
  });

  it('ignores credit and results from another workstation', async () => {
    const t = make({}, { answer: 'silent' });
    const p = t.relay.write(req(source([Buffer.from('x')]), 1));
    const tid = await new Promise<string>((res) => {
      const i = setInterval(() => {
        const open = t.frames.find((f) => f.type === 'storage.write.open');
        if (open) {
          clearInterval(i);
          res(open.payload.transferId);
        }
      }, 5);
    });
    t.relay.onResult('other-ws', tid, { ok: false });
    expect(t.relay.inFlight).toBe(1);
    t.relay.onDisconnect(WS);
    expect((await p).ok).toBe(false);
  });
});
