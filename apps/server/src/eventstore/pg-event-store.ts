import { DomainEventSchema } from '@aom/shared';
import type pg from 'pg';
import type { Clock } from '../clock.ts';
import { rows } from '../db/sql.ts';
import { APPEND_LOCK_ID, type Tx, withTx } from '../db/tx.ts';
import {
  type AppendInput,
  ConcurrencyError,
  type EventStore,
  type ProjectorMap,
  type StoredEvent,
} from './types.ts';

const COLS = `seq, id, stream_id, stream_version, type, payload, actor_kind, actor_id, org_id, project_id,
  audience, correlation_id, causation_id, created_at`;

export function rowToEvent(r: Record<string, any>): StoredEvent {
  return {
    seq: BigInt(r.seq),
    id: r.id,
    streamId: r.stream_id,
    streamVersion: r.stream_version,
    event: { type: r.type, payload: r.payload } as StoredEvent['event'],
    actor: { kind: r.actor_kind, id: r.actor_id },
    scope: { orgId: r.org_id, projectId: r.project_id, audience: r.audience },
    correlationId: r.correlation_id ?? undefined,
    causationId: r.causation_id ?? undefined,
    createdAt: new Date(r.created_at),
  };
}

export type Subscriber = (e: StoredEvent) => void | Promise<void>;
/** Runs inside the append transaction, before the events are stored: may adjust payloads and add events to the batch. */
export type Interceptor = (tx: Tx, inputs: AppendInput[]) => Promise<AppendInput[]>;

export class PgEventStore implements EventStore {
  private subscribers = new Set<Subscriber>();
  private interceptors: Interceptor[] = [];

  constructor(
    private readonly pool: pg.Pool,
    private readonly projectors: ProjectorMap,
    private readonly clock: Clock,
  ) {}

  async append(inputs: AppendInput[], opts: { tx?: Tx } = {}): Promise<StoredEvent[]> {
    if (inputs.length === 0) return [];
    // Validate before touching the DB.
    inputs.forEach((i) => void DomainEventSchema.parse(i.event));
    const run = async (tx: Tx): Promise<StoredEvent[]> => {
      // Re-entrant: commands that took the lock via withAppendTx already hold it.
      await tx.query('SELECT pg_advisory_xact_lock($1)', [APPEND_LOCK_ID]);
      let batch = inputs;
      for (const intercept of this.interceptors) batch = await intercept(tx, batch);
      const parsed = batch.map((i) => DomainEventSchema.parse(i.event));
      const stored: StoredEvent[] = [];
      const versions = new Map<string, number>();
      for (const [idx, input] of batch.entries()) {
        const ev = parsed[idx] as StoredEvent['event'];
        let current = versions.get(input.streamId);
        if (current === undefined) {
          const r = await rows<{ v: number | null }>(
            tx,
            'SELECT max(stream_version) AS v FROM events WHERE stream_id = $1',
            [input.streamId],
          );
          current = r[0]?.v ?? 0;
        }
        const exp = input.expectedVersion ?? 'any';
        if (exp === 'no_stream' && current !== 0)
          throw new ConcurrencyError(input.streamId, 'no_stream', current);
        if (typeof exp === 'number' && exp !== current)
          throw new ConcurrencyError(input.streamId, exp, current);
        const version = current + 1;
        versions.set(input.streamId, version);
        const r = await rows(
          tx,
          `INSERT INTO events (stream_id, stream_version, type, payload, actor_kind, actor_id, org_id,
             project_id, audience, correlation_id, causation_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${COLS}`,
          [
            input.streamId,
            version,
            ev.type,
            JSON.stringify(ev.payload),
            input.actor.kind,
            input.actor.id,
            input.scope.orgId,
            input.scope.projectId,
            input.scope.audience,
            input.correlationId ?? null,
            input.causationId ?? null,
            this.clock.now(),
          ],
        );
        const se = rowToEvent(r[0] as Record<string, any>);
        stored.push(se);
        for (const p of this.projectors[se.event.type] ?? []) await p(tx, se);
      }
      const last = stored[stored.length - 1] as StoredEvent;
      await tx.query('SELECT pg_notify($1, $2)', ['aom_events', last.seq.toString()]);
      return stored;
    };
    return opts.tx ? run(opts.tx) : withTx(this.pool, run);
  }

  /** Registers a hook that runs inside every append transaction (the BA routing, `reporter/routing.ts`). */
  intercept(fn: Interceptor): void {
    this.interceptors.push(fn);
  }

  /** Runs the projectors for an already stored event (used by `projections:rebuild`). */
  async project(tx: Tx, e: StoredEvent): Promise<void> {
    for (const p of this.projectors[e.event.type] ?? []) await p(tx, e);
  }

  async read(streamId: string, fromVersion = 1): Promise<StoredEvent[]> {
    const r = await rows(
      this.pool,
      `SELECT ${COLS} FROM events WHERE stream_id = $1 AND stream_version >= $2 ORDER BY stream_version`,
      [streamId, fromVersion],
    );
    return r.map(rowToEvent);
  }

  async readAll(afterSeq: bigint, limit = 500): Promise<StoredEvent[]> {
    const r = await rows(this.pool, `SELECT ${COLS} FROM events WHERE seq > $1 ORDER BY seq LIMIT $2`, [
      afterSeq.toString(),
      limit,
    ]);
    return r.map(rowToEvent);
  }

  async maxSeq(): Promise<bigint> {
    const r = await rows<{ m: string | null }>(this.pool, 'SELECT max(seq) AS m FROM events');
    return BigInt(r[0]?.m ?? 0);
  }

  /** Registers a handler. Delivery is driven by the notifier (`dispatch`). */
  subscribe(handler: Subscriber): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  /** Called by the notifier for each committed event, in seq order. Errors in handlers are isolated. */
  async dispatch(e: StoredEvent, onError: (err: unknown) => void): Promise<void> {
    for (const s of [...this.subscribers]) {
      try {
        await s(e);
      } catch (err) {
        onError(err);
      }
    }
  }
}
