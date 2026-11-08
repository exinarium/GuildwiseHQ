import { describe, expect, it } from 'vitest';
import { StorageRelay, type StorageRelayDeps } from '../src/storage-relay/hub.ts';

const CONN = '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11';
const SUB = '4f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const WS = 'ws-1';
type Frame = { type: string; payload: Record<string, any> };

function make(over: Partial<StorageRelayDeps> = {}, onSend?: (f: Frame, relay: StorageRelay) => void) {
  const frames: Frame[] = [];
  const logs: any[] = [];
  const deps: StorageRelayDeps = {
    config: {
      writeTimeoutMs: 5000,
      maxFileBytes: 1e6,
      maxInFlight: 2,
      deleteTimeoutMs: 100,
      maxDeletesInFlight: 2,
    },
    lookup: async (_o, id) => (id === CONN ? { kind: 'local', workstationId: WS } : undefined),
    isOnline: () => true,
    send: (_ws, type, payload) => {
      const f = { type, payload: payload as Record<string, any> };
      frames.push(f);
      queueMicrotask(() => onSend?.(f, relay));
      return true;
    },
    onOutcome: () => undefined,
    log: () => undefined,
    logDelete: (e) => void logs.push(e),
    ...over,
  };
  const relay: StorageRelay = new StorageRelay(deps);
  return { relay, frames, logs };
}
const req = { orgId: 'o', connectionId: CONN, path: 'Forms/Acme/a.pdf', submissionId: SUB };

describe('StorageRelay.delete', () => {
  it.each(['deleted', 'not_found'] as const)(
    'sends storage.delete and resolves %s as success',
    async (result) => {
      const t = make({}, (f, r) => r.onDeleteResult(WS, f.payload.requestId, { ok: true, result }));
      await expect(t.relay.delete({ ...req, providerId: 'id1' })).resolves.toEqual({ ok: true, result });
      expect(t.frames).toHaveLength(1);
      expect(t.frames[0]?.type).toBe('storage.delete');
      expect(t.frames[0]?.payload).toMatchObject({
        connectionId: CONN,
        path: 'Forms/Acme/a.pdf',
        providerId: 'id1',
        submissionId: SUB,
      });
      expect(t.relay.inFlight).toBe(0);
    },
  );

  it('returns a typed runner error as a failure that counts', async () => {
    const error = { code: 'permission' as const, message: 'refused', retryable: false };
    const t = make({}, (f, r) => r.onDeleteResult(WS, f.payload.requestId, { ok: false, error }));
    const r = await t.relay.delete(req);
    expect(r).toEqual({ ok: false, error });
  });

  it('treats ok without a valid result as a failure', async () => {
    const t = make({}, (f, r) => r.onDeleteResult(WS, f.payload.requestId, { ok: true, result: 'weird' }));
    const r = await t.relay.delete(req);
    expect(r).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });

  it('fails as retryable when the runner disconnects during the delete', async () => {
    const t = make({}, (_f, r) => r.onDisconnect(WS));
    const r = await t.relay.delete(req);
    expect(r).toMatchObject({ ok: false, error: { code: 'unavailable', retryable: true } });
    expect((r as { notTried?: boolean }).notTried).toBeUndefined();
  });

  it('times out when the runner is silent (an old runner drops the frame)', async () => {
    const t = make();
    const r = await t.relay.delete(req);
    expect(r).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(t.relay.inFlight).toBe(0);
  });

  it('is not tried when the runner is offline, and sends nothing', async () => {
    const t = make({ isOnline: () => false });
    const r = await t.relay.delete(req);
    expect(r).toMatchObject({ ok: false, notTried: true, error: { code: 'runner_offline' } });
    expect(t.frames).toHaveLength(0);
  });

  it('is not tried and sends nothing when the runner does not know storage.delete', async () => {
    const t = make({ supportsDelete: async () => false });
    const r = await t.relay.delete(req);
    expect(r).toMatchObject({ ok: false, notTried: true, error: { code: 'unavailable' } });
    expect(t.frames).toHaveLength(0);
  });

  it('is not tried when the socket is gone at send time', async () => {
    const t = make({ send: () => false });
    expect(await t.relay.delete(req)).toMatchObject({
      ok: false,
      notTried: true,
      error: { code: 'runner_offline' },
    });
  });

  it('refuses a missing connection without counting it as offline', async () => {
    const t = make();
    const r = await t.relay.delete({ ...req, connectionId: '9b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11' });
    expect(r).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect((r as { notTried?: boolean }).notTried).toBeUndefined();
  });

  it('has its own cap and does not use upload slots', async () => {
    const t = make({
      config: {
        writeTimeoutMs: 5000,
        maxFileBytes: 1e6,
        maxInFlight: 0,
        deleteTimeoutMs: 200,
        maxDeletesInFlight: 1,
      },
    });
    const first = t.relay.delete(req);
    await new Promise((r) => setTimeout(r, 10));
    expect(await t.relay.delete(req)).toMatchObject({
      ok: false,
      notTried: true,
      error: { code: 'unavailable' },
    });
    expect(t.relay.inFlight).toBe(0);
    await first;
  });

  it('ignores a result from another workstation', async () => {
    const t = make({}, (f, r) =>
      r.onDeleteResult('other', f.payload.requestId, { ok: true, result: 'deleted' }),
    );
    expect(await t.relay.delete(req)).toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it('logs a path hash and never the path', async () => {
    const t = make({}, (f, r) => r.onDeleteResult(WS, f.payload.requestId, { ok: true, result: 'deleted' }));
    await t.relay.delete(req);
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toMatchObject({
      connectionId: CONN,
      kind: 'local',
      submissionId: SUB,
      outcome: 'deleted',
    });
    expect(t.logs[0].pathHash).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(t.logs)).not.toContain('Acme');
  });
});
