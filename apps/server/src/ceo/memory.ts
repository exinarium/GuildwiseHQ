import { createHash, randomUUID } from 'node:crypto';
import { type CeoMemoryKind, type CeoMemorySource, type CeoMemoryStatus, streamId } from '@aom/shared';
import { agentActor, orgScope, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';

export const textHash = (t: string): string => createHash('sha256').update(t).digest('hex');

export interface NewMemory {
  orgId: string;
  kind: CeoMemoryKind;
  scope?: string;
  source: CeoMemorySource;
  sourceRef?: string;
  confidence: number;
  status: CeoMemoryStatus;
  text: string;
  quote?: string;
  cls?: string;
  /** The owner who stated it (user actor) or the CEO agent that recorded it. */
  byUserId?: string;
  byAgentId?: string;
}

/** Records a memory: the event carries the hash, the text goes to the operational table in the same transaction. */
export async function addMemoryIn(ctx: Ctx, tx: Tx, m: NewMemory): Promise<string> {
  const memoryId = randomUUID();
  await exec(tx, 'INSERT INTO ceo_memory_text (memory_id, org_id, text, quote) VALUES ($1,$2,$3,$4)', [
    memoryId,
    m.orgId,
    m.text,
    m.quote ?? '',
  ]);
  await ctx.store.append(
    [
      {
        streamId: streamId.ceo(m.orgId),
        event: {
          type: 'CeoMemoryAdded',
          payload: {
            memoryId,
            orgId: m.orgId,
            kind: m.kind,
            scope: m.scope ?? 'org',
            source: m.source,
            sourceRef: m.sourceRef ?? '',
            confidence: m.confidence,
            status: m.status,
            textHash: textHash(m.text),
            ...(m.cls ? { class: m.cls } : {}),
            ...(m.byUserId ? { by: m.byUserId } : {}),
          },
        },
        actor: m.byAgentId
          ? agentActor(m.byAgentId)
          : m.byUserId
            ? userActor(m.byUserId)
            : { kind: 'system', id: null },
        scope: orgScope(m.orgId),
      },
    ],
    { tx },
  );
  return memoryId;
}

export const addMemory = (ctx: Ctx, m: NewMemory): Promise<string> =>
  withAppendTx(ctx.pool, (tx) => addMemoryIn(ctx, tx, m));

export interface MemoryDto {
  id: string;
  kind: string;
  scope: string;
  source: string;
  sourceRef: string;
  confidence: number;
  status: string;
  observations: number;
  class: string | null;
  text: string;
  quote: string;
  createdAt: string;
  lastConfirmedAt: string | null;
}

const toDto = (r: Row): MemoryDto => ({
  id: r.id,
  kind: r.kind,
  scope: r.scope,
  source: r.source,
  sourceRef: r.source_ref,
  confidence: r.confidence,
  status: r.status,
  observations: r.observations,
  class: r.class ?? null,
  text: r.text ?? '',
  quote: r.quote ?? '',
  createdAt: new Date(r.created_at).toISOString(),
  lastConfirmedAt: r.last_confirmed_at ? new Date(r.last_confirmed_at).toISOString() : null,
});

const SELECT = `SELECT m.*, t.text, t.quote FROM ceo_memories m LEFT JOIN ceo_memory_text t ON t.memory_id = m.id`;

export async function listMemories(
  ctx: Ctx,
  orgId: string,
  opts: { status?: string; includeRetired?: boolean } = {},
): Promise<MemoryDto[]> {
  const list = await rows(
    ctx.pool,
    `${SELECT} WHERE m.org_id=$1 AND m.status <> 'forgotten' AND ($2::text IS NULL OR m.status=$2)
        AND ($3::boolean OR m.status <> 'retired')
      ORDER BY (m.status='candidate') DESC, m.created_at DESC LIMIT 300`,
    [orgId, opts.status ?? null, opts.includeRetired === true],
  );
  return list.map(toDto);
}

/** The memories a brief carries: active rules and preferences always (capped), plus text matches for the topic. */
export async function relevantMemories(
  ctx: Ctx,
  orgId: string,
  topic: string,
  limit = 15,
): Promise<MemoryDto[]> {
  const words = [
    ...new Set(
      topic
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4),
    ),
  ].slice(0, 12);
  const always = await rows(
    ctx.pool,
    `${SELECT} WHERE m.org_id=$1 AND m.status='active' AND m.kind IN ('rule','preference') ORDER BY m.confidence DESC, m.created_at DESC LIMIT 10`,
    [orgId],
  );
  const seen = new Set(always.map((r) => r.id));
  const matched = words.length
    ? await rows(
        ctx.pool,
        `${SELECT} WHERE m.org_id=$1 AND m.status='active' AND t.search @@ to_tsquery('simple', $2)
          ORDER BY m.confidence DESC LIMIT $3`,
        [orgId, words.join(' | '), limit],
      )
    : [];
  return [...always, ...matched.filter((r) => !seen.has(r.id))].slice(0, limit).map(toDto);
}

export async function searchMemories(ctx: Ctx, orgId: string, q: string): Promise<MemoryDto[]> {
  const words = q
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 8);
  if (!words.length) return [];
  const list = await rows(
    ctx.pool,
    `${SELECT} WHERE m.org_id=$1 AND m.status IN ('active','candidate') AND t.search @@ to_tsquery('simple', $2) LIMIT 10`,
    [orgId, words.join(' | ')],
  );
  return list.map(toDto);
}

async function lockMemory(tx: Tx, orgId: string, id: string): Promise<Row> {
  const m = await one(
    tx,
    `SELECT * FROM ceo_memories WHERE id=$1 AND org_id=$2 AND status <> 'forgotten' FOR UPDATE`,
    [id, orgId],
  );
  if (!m) throw notFound('memory not found');
  return m;
}

const ownerEvent = (orgId: string, userId: string, event: any) => ({
  streamId: streamId.ceo(orgId),
  event,
  actor: userActor(userId),
  scope: orgScope(orgId),
});

export async function confirmMemory(ctx: Ctx, orgId: string, userId: string, id: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    await lockMemory(tx, orgId, id);
    await ctx.store.append(
      [
        ownerEvent(orgId, userId, {
          type: 'CeoMemoryConfirmed',
          payload: { memoryId: id, orgId, by: userId, status: 'active' },
        }),
      ],
      { tx },
    );
  });
}

export async function retireMemory(ctx: Ctx, orgId: string, userId: string, id: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    await lockMemory(tx, orgId, id);
    await ctx.store.append(
      [
        ownerEvent(orgId, userId, {
          type: 'CeoMemoryRetired',
          payload: { memoryId: id, orgId, by: userId, reason: 'retired by the owner' },
        }),
      ],
      { tx },
    );
  });
}

export async function editMemory(
  ctx: Ctx,
  orgId: string,
  userId: string,
  id: string,
  patch: { text?: string | undefined; scope?: string | undefined; confirm?: boolean | undefined },
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const m = await lockMemory(tx, orgId, id);
    if (m.status === 'retired') throw conflict('retired', 'this memory is retired');
    const events = [];
    if (patch.text !== undefined) {
      await exec(tx, 'UPDATE ceo_memory_text SET text=$2 WHERE memory_id=$1', [id, patch.text]);
      events.push(
        ownerEvent(orgId, userId, {
          type: 'CeoMemoryEdited',
          payload: {
            memoryId: id,
            orgId,
            textHash: textHash(patch.text),
            ...(patch.scope ? { scope: patch.scope } : {}),
            by: userId,
          },
        }),
      );
    } else if (patch.scope) {
      events.push(
        ownerEvent(orgId, userId, {
          type: 'CeoMemoryEdited',
          payload: { memoryId: id, orgId, textHash: m.text_hash, scope: patch.scope, by: userId },
        }),
      );
    }
    if (patch.confirm || m.status === 'candidate')
      if (patch.confirm !== false)
        events.push(
          ownerEvent(orgId, userId, {
            type: 'CeoMemoryConfirmed',
            payload: { memoryId: id, orgId, by: userId, status: 'active' },
          }),
        );
    await ctx.store.append(events, { tx });
  });
}

/** "Forget": the text row is deleted for good; the projection keeps a tombstone without any content. */
export async function forgetMemory(ctx: Ctx, orgId: string, userId: string, id: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    await lockMemory(tx, orgId, id);
    await ctx.store.append(
      [
        ownerEvent(orgId, userId, {
          type: 'CeoMemoryForgotten',
          payload: { memoryId: id, orgId, by: userId },
        }),
      ],
      { tx },
    );
  });
}

/** The owner adds a rule by hand. */
export async function addOwnerRule(
  ctx: Ctx,
  orgId: string,
  userId: string,
  text: string,
  scope = 'org',
): Promise<string> {
  return addMemory(ctx, {
    orgId,
    kind: 'rule',
    scope,
    source: 'owner_statement',
    sourceRef: 'memory_tab',
    confidence: 0.95,
    status: 'active',
    text,
    byUserId: userId,
  });
}

/** An owner's own desk answer with "remember this": a rule with the quote. */
export async function rememberFromDeskAnswer(
  ctx: Ctx,
  orgId: string,
  userId: string,
  item: { id: string; title: string; subkind?: string | null },
  answer: string,
): Promise<string> {
  return addMemory(ctx, {
    orgId,
    kind: 'rule',
    source: 'owner_desk_answer',
    sourceRef: `desk:${item.id}`,
    confidence: 0.95,
    status: 'active',
    text: `When asked "${item.title.replace(/\s+/g, ' ').slice(0, 200)}" the owner answered: ${answer.replace(/\s+/g, ' ').slice(0, 400)}`,
    quote: answer.slice(0, 1000),
    byUserId: userId,
    ...(item.subkind ? { scope: `subkind:${item.subkind}` } : {}),
  });
}
