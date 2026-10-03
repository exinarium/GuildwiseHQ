import type { Actor, DomainEvent, Scope } from '@aom/shared';
import type { Tx } from '../db/tx.ts';

export interface AppendInput<E extends DomainEvent = DomainEvent> {
  streamId: string;
  /** default 'any' */
  expectedVersion?: number | 'any' | 'no_stream';
  event: E;
  actor: Actor;
  scope: Scope;
  correlationId?: string;
  causationId?: string;
}

export interface StoredEvent<E extends DomainEvent = DomainEvent> extends AppendInput<E> {
  seq: bigint;
  id: string;
  streamVersion: number;
  createdAt: Date;
}

export interface EventStore {
  /** Appends atomically (all or nothing) inside `tx` (or a new tx), runs projectors, notifies on commit. */
  append(inputs: AppendInput[], opts?: { tx?: Tx }): Promise<StoredEvent[]>;
  read(streamId: string, fromVersion?: number): Promise<StoredEvent[]>;
  readAll(afterSeq: bigint, limit?: number): Promise<StoredEvent[]>;
  /** In-process fan-out of committed events in seq order; at-least-once; handler must be idempotent. */
  subscribe(handler: (e: StoredEvent) => void | Promise<void>, opts?: { afterSeq?: bigint }): () => void;
}

export class ConcurrencyError extends Error {
  constructor(
    readonly streamId: string,
    readonly expected: number | 'no_stream',
    readonly actual: number,
  ) {
    super(`concurrency conflict on ${streamId}: expected ${expected}, actual ${actual}`);
    this.name = 'ConcurrencyError';
  }
}

export type Projector = (tx: Tx, e: StoredEvent) => Promise<void>;
/** event type -> projector(s). Several domains may project the same event; they run in registration order. */
export type ProjectorMap = Record<string, Projector[]>;
