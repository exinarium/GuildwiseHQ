import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClock } from '../src/clock.ts';
import { createPool } from '../src/db/pool.ts';
import { Notifier } from '../src/eventstore/notifier.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { type AppendInput, ConcurrencyError, type ProjectorMap } from '../src/eventstore/types.ts';
import { closeAdminPool, q, resetDb, TEST_DB_URL } from './helpers/db.ts';

const pool = createPool(TEST_DB_URL, 30);
const renamed = (workstationId: string, name = 'ws'): AppendInput => ({
  streamId: `workstation-${workstationId}`,
  event: { type: 'WorkstationRenamed', payload: { workstationId, name } },
  actor: { kind: 'system', id: null },
  scope: { orgId: null, projectId: null, audience: 'system' },
});

beforeEach(resetDb);
afterAll(async () => {
  await pool.end();
  await closeAdminPool();
});

describe('PgEventStore', () => {
  it('appends events with increasing seq and stream versions and reads them back', async () => {
    const store = new PgEventStore(pool, {}, createClock());
    const ws = randomUUID();
    const a = await store.append([renamed(ws, 'a'), renamed(ws, 'b')]);
    expect(a.map((e) => e.streamVersion)).toEqual([1, 2]);
    expect(a[1]!.seq).toBeGreaterThan(a[0]!.seq);
    const read = await store.read(`workstation-${ws}`);
    expect(read.map((e) => e.event.type)).toEqual(['WorkstationRenamed', 'WorkstationRenamed']);
    expect((read[1]!.event.payload as { name: string }).name).toBe('b');
    expect((await store.readAll(a[0]!.seq)).length).toBe(1);
  });

  it('rolls events back when a projector throws (atomic with projections)', async () => {
    const projectors: ProjectorMap = {
      WorkstationRenamed: [
        async (_tx, e) => {
          if ((e.event.payload as { name: string }).name === 'boom') throw new Error('projector failed');
        },
      ],
    };
    const store = new PgEventStore(pool, projectors, createClock());
    const ws = randomUUID();
    await expect(store.append([renamed(ws, 'ok'), renamed(ws, 'boom')])).rejects.toThrow('projector failed');
    expect(await q('SELECT 1 FROM events')).toHaveLength(0);
  });

  it('raises ConcurrencyError on expectedVersion conflicts', async () => {
    const store = new PgEventStore(pool, {}, createClock());
    const ws = randomUUID();
    await store.append([{ ...renamed(ws), expectedVersion: 'no_stream' }]);
    await expect(store.append([{ ...renamed(ws), expectedVersion: 'no_stream' }])).rejects.toBeInstanceOf(
      ConcurrencyError,
    );
    await expect(store.append([{ ...renamed(ws), expectedVersion: 5 }])).rejects.toBeInstanceOf(
      ConcurrencyError,
    );
    await store.append([{ ...renamed(ws), expectedVersion: 1 }]);
    expect((await store.read(`workstation-${ws}`)).length).toBe(2);
  });

  it('rejects invalid events before touching the database', async () => {
    const store = new PgEventStore(pool, {}, createClock());
    await expect(
      store.append([
        { ...renamed(randomUUID()), event: { type: 'WorkstationRenamed', payload: { name: '' } } } as never,
      ]),
    ).rejects.toThrow();
    expect(await q('SELECT 1 FROM events')).toHaveLength(0);
  });

  it('makes events append-only (UPDATE and DELETE fail)', async () => {
    const store = new PgEventStore(pool, {}, createClock());
    await store.append([renamed(randomUUID())]);
    await expect(q(`UPDATE events SET type = 'x'`)).rejects.toThrow(/append-only/);
    await expect(q('DELETE FROM events')).rejects.toThrow(/append-only/);
  });

  it('uses the injected clock for created_at', async () => {
    const clock = createClock();
    clock.advance(3600_000);
    const store = new PgEventStore(pool, {}, clock);
    const [e] = await store.append([renamed(randomUUID())]);
    expect(e!.createdAt.getTime() - Date.now()).toBeGreaterThan(3500_000);
  });

  describe('subscribe', () => {
    let store: PgEventStore;
    let notifier: Notifier;
    beforeAll(async () => {
      store = new PgEventStore(pool, {}, createClock());
      notifier = new Notifier(TEST_DB_URL, store);
    });

    it('delivers committed events in seq order exactly once under 20 concurrent appenders (1000 events)', async () => {
      await notifier.start();
      const seen: bigint[] = [];
      store.subscribe((e) => {
        seen.push(e.seq);
      });
      await Promise.all(
        Array.from({ length: 20 }, async (_, w) => {
          const ws = randomUUID();
          for (let i = 0; i < 50; i++) await store.append([renamed(ws, `w${w}-${i}`)]);
        }),
      );
      await notifier.flush();
      await notifier.stop();
      expect(seen).toHaveLength(1000);
      expect(new Set(seen).size).toBe(1000);
      for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    });
  });
});
