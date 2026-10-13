import { createHash, randomUUID } from 'node:crypto';
import {
  AttachBeginParamsSchema,
  type BriefAttachment,
  type CardAttachmentDto,
  type CardAttachmentsResponse,
  checkAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_CARD_ATTACHMENT_BYTES,
  MAX_CARD_ATTACHMENTS,
  safeAttachmentName,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { loadManageable } from './cards.ts';
import { agentActor, projectScope, userActor } from './common.ts';
import { intakeOf, type RpcReply } from './intake.ts';

/**
 * Card attachments (docs/USER-GUIDE.md "Attachments"). The bytes are in `card_attachment_data` (Postgres, operational:
 * never in the event log, kept over a projection rebuild); `CardAttachmentAdded/Removed` carry metadata only. Who may
 * add or remove: whoever may edit the card (its owner and the project owner), and the BA for the cards of its own intake.
 */

export const attachmentLimits = {
  maxFileBytes: MAX_ATTACHMENT_BYTES,
  maxCardBytes: MAX_CARD_ATTACHMENT_BYTES,
  maxFiles: MAX_CARD_ATTACHMENTS,
};

const toDto = (r: Row, cardId: string): CardAttachmentDto => ({
  id: r.id,
  cardId,
  name: r.name,
  contentType: r.content_type,
  size: r.size,
  sha256: r.sha256,
  image: /^image\//.test(r.content_type),
  addedByName: r.user_name ?? r.agent_name ?? null,
  addedByAgent: !!r.added_by_agent,
  source: r.source ?? null,
  createdAt: iso(r.created_at) as string,
});

const WITH_NAMES = `SELECT a.*, u.display_name AS user_name, g.name AS agent_name FROM card_attachments a
       LEFT JOIN users u ON u.id = a.added_by_user LEFT JOIN agents g ON g.id = a.added_by_agent`;

export async function attachmentsOf(db: Queryable, cardId: string): Promise<CardAttachmentDto[]> {
  const r = await rows(db, `${WITH_NAMES} WHERE a.card_id=$1 ORDER BY a.created_at, a.event_seq`, [cardId]);
  return r.map((x) => toDto(x, cardId));
}

export async function attachmentListing(db: Queryable, cardId: string): Promise<CardAttachmentsResponse> {
  return { attachments: await attachmentsOf(db, cardId), limits: attachmentLimits };
}

/** The attachments a shift's brief carries. */
export async function briefAttachments(db: Queryable, cardId: string): Promise<BriefAttachment[]> {
  return (await attachmentsOf(db, cardId)).map((a) => ({
    id: a.id,
    name: a.name,
    contentType: a.contentType,
    size: a.size,
    sha256: a.sha256,
  }));
}

type Actor = { kind: 'user'; userId: string } | { kind: 'agent'; agentId: string };

/** Validates and stores one file on a card inside a transaction. Idempotent: the same name and content is not added twice. */
export async function addAttachmentIn(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  actor: Actor,
  file: { name: string; bytes: Buffer; source?: string | undefined },
): Promise<CardAttachmentDto> {
  if (['done', 'cancelled'].includes(card.status))
    throw conflict('card_closed', `${card.ref} is ${card.status}: attachments can no longer be changed`);
  const name = safeAttachmentName(file.name);
  const check = checkAttachment(name, file.bytes);
  if (!check.ok) throw unprocessable('attachment_rejected', `${name}: ${check.reason}`);
  // Serialize concurrent uploads to one card.
  await one(tx, 'SELECT id FROM cards WHERE id=$1 FOR UPDATE', [card.id]);
  const sha256 = createHash('sha256').update(file.bytes).digest('hex');
  const existing = await one(tx, `${WITH_NAMES} WHERE a.card_id=$1 AND a.name=$2 AND a.sha256=$3`, [
    card.id,
    name,
    sha256,
  ]);
  if (existing) return toDto(existing, card.id);
  const used = (await one(
    tx,
    'SELECT count(*)::int AS n, COALESCE(sum(size),0)::bigint AS bytes FROM card_attachments WHERE card_id=$1',
    [card.id],
  )) as Row;
  if (used.n >= MAX_CARD_ATTACHMENTS)
    throw unprocessable('too_many_attachments', `a card holds at most ${MAX_CARD_ATTACHMENTS} attachments`);
  if (Number(used.bytes) + file.bytes.byteLength > MAX_CARD_ATTACHMENT_BYTES)
    throw unprocessable(
      'attachments_too_large',
      `a card holds at most ${MAX_CARD_ATTACHMENT_BYTES / 1024 / 1024} MB of attachments`,
    );
  const id = randomUUID();
  await exec(tx, 'INSERT INTO card_attachment_data (id, data) VALUES ($1,$2)', [id, file.bytes]);
  await ctx.store.append(
    [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardAttachmentAdded',
          payload: {
            cardId: card.id,
            attachmentId: id,
            name,
            contentType: check.kind.contentType,
            size: file.bytes.byteLength,
            sha256,
            ...(file.source ? { source: file.source } : {}),
          },
        },
        actor: actor.kind === 'user' ? userActor(actor.userId) : agentActor(actor.agentId),
        scope: projectScope(card.org_id, card.project_id),
      },
    ],
    { tx },
  );
  const row = (await one(tx, `${WITH_NAMES} WHERE a.id=$1`, [id])) as Row;
  return toDto(row, card.id);
}

/** The manager attaches a file (web upload). */
export async function uploadAttachment(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  name: string,
  bytes: Buffer,
): Promise<CardAttachmentDto> {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, user, idOrRef);
    return addAttachmentIn(ctx, tx, card, { kind: 'user', userId: user.id }, { name, bytes });
  });
}

export async function removeAttachment(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  attachmentId: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, user, idOrRef);
    if (['done', 'cancelled'].includes(card.status))
      throw conflict('card_closed', `${card.ref} is ${card.status}: attachments can no longer be changed`);
    const a = await one(tx, 'SELECT * FROM card_attachments WHERE id=$1 AND card_id=$2', [
      attachmentId,
      card.id,
    ]);
    if (!a) throw notFound('attachment not found');
    await exec(tx, 'DELETE FROM card_attachment_data WHERE id=$1', [attachmentId]);
    await ctx.store.append(
      [
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'CardAttachmentRemoved',
            payload: { cardId: card.id, attachmentId, name: a.name },
          },
          actor: userActor(user.id),
          scope: projectScope(card.org_id, card.project_id),
        },
      ],
      { tx },
    );
  });
}

/** A file for a member who can see the card. */
export async function readAttachment(
  ctx: Ctx,
  userId: string,
  idOrRef: string,
  attachmentId: string,
): Promise<{ name: string; contentType: string; data: Buffer }> {
  const { card } = await loadVisibleCard(ctx.pool, userId, idOrRef);
  return readAttachmentOf(ctx.pool, card.id, attachmentId);
}

async function readAttachmentOf(
  db: Queryable,
  cardId: string,
  attachmentId: string,
): Promise<{ name: string; contentType: string; data: Buffer }> {
  const a = await one(
    db,
    `SELECT a.name, a.content_type, d.data FROM card_attachments a JOIN card_attachment_data d ON d.id = a.id
      WHERE a.id=$1 AND a.card_id=$2`,
    [attachmentId, cardId],
  );
  if (!a) throw notFound('attachment not found');
  return { name: a.name, contentType: a.content_type, data: a.data };
}

// -------------------------------------------------------------------------------------- what an agent may reach

/**
 * The cards whose attachments a shift or chat may read, and (intake only) attach to. A card shift: its own card. A
 * DevOps shift: the card its request was filed for. A chat: the cards of its intake, plus the card it is about.
 */
async function agentScope(ctx: Ctx, shift: Row): Promise<{ cards: Row[]; attachable: Set<string> }> {
  const cards = new Map<string, Row>();
  const attachable = new Set<string>();
  const byId = async (id: string) => {
    const c = await one(ctx.pool, 'SELECT * FROM cards WHERE id=$1', [id]);
    if (c) cards.set(c.id, c);
  };
  if (shift.kind === 'devops') {
    const req = await one(ctx.pool, 'SELECT card_id FROM devops_requests WHERE shift_id=$1', [shift.id]);
    if (req?.card_id) await byId(req.card_id);
  } else if (shift.kind === 'chat') {
    const who = await intakeOf(ctx, shift);
    if (who) {
      const r = await rows(
        ctx.pool,
        `SELECT c.* FROM cards c JOIN intake_cards ic ON ic.card_id = c.id WHERE ic.intake_id=$1 ORDER BY c.number`,
        [who.intake.id],
      );
      for (const c of r) {
        cards.set(c.id, c);
        attachable.add(c.id);
      }
    }
    if (shift.card_id) await byId(shift.card_id);
  } else if (shift.card_id) {
    await byId(shift.card_id);
  }
  return { cards: [...cards.values()], attachable };
}

function pick(cards: Row[], ref: unknown, what: string): Row {
  if (typeof ref === 'string' && ref.trim()) {
    const c = cards.find((x) => String(x.ref).toUpperCase() === ref.trim().toUpperCase());
    if (!c)
      throw new Error(
        `${ref} is not a card you can ${what} here${cards.length ? ` (yours: ${cards.map((x) => x.ref).join(', ')})` : ''}`,
      );
    return c;
  }
  if (cards.length === 1) return cards[0] as Row;
  throw new Error(
    cards.length === 0
      ? `there is no card to ${what} yet: create one first`
      : `name the card with --card <REF> (${cards.map((x) => x.ref).join(', ')})`,
  );
}

/**
 * `card.attachments` (list the attachments of the cards in this shift's reach) and `card.attach.begin` (the BA asks to
 * attach a file to a card of its intake: the answer is an upload ticket; the runner then sends the bytes over HTTP).
 */
export async function attachmentRpc(
  ctx: Ctx,
  shift: Row,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  try {
    const scope = await agentScope(ctx, shift);
    if (method === 'card.attachments') {
      const ref = typeof params.ref === 'string' ? params.ref : undefined;
      // Without a ref: every card in reach (an intake lists all its cards).
      const cards = ref || scope.cards.length === 1 ? [pick(scope.cards, ref, 'read')] : scope.cards;
      const out = [];
      for (const c of cards)
        out.push({ ref: c.ref, title: c.title, attachments: await attachmentsOf(ctx.pool, c.id) });
      return [true, { cards: out, limits: attachmentLimits }];
    }
    if (method === 'card.attach.begin') {
      const p = AttachBeginParamsSchema.safeParse(params);
      if (!p.success) return [false, undefined, 'usage: aom card attach <path> [--card <REF>]'];
      if (shift.kind !== 'chat' || scope.attachable.size === 0)
        return [
          false,
          undefined,
          'only the BA, in its intake chat, can attach files to the cards it created',
        ];
      const card = pick(
        scope.cards.filter((c) => scope.attachable.has(c.id)),
        p.data.ref,
        'attach files to',
      );
      if (['done', 'cancelled'].includes(card.status))
        return [false, undefined, `${card.ref} is ${card.status}: attachments can no longer be changed`];
      const name = safeAttachmentName(p.data.name);
      if (p.data.size > MAX_ATTACHMENT_BYTES)
        return [
          false,
          undefined,
          `${name}: the file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`,
        ];
      const uploadId = randomUUID();
      await exec(ctx.pool, 'DELETE FROM card_attachment_uploads WHERE expires_at < $1', [ctx.clock.now()]);
      await exec(
        ctx.pool,
        `INSERT INTO card_attachment_uploads (id, workstation_id, shift_id, card_id, agent_id, name, size, sha256, source, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          uploadId,
          shift.workstation_id,
          shift.id,
          card.id,
          shift.agent_id,
          name,
          p.data.size,
          p.data.sha256,
          p.data.source ?? null,
          new Date(ctx.clock.now().getTime() + 10 * 60_000),
        ],
      );
      return [true, { uploadId, ref: card.ref, name }];
    }
    return [false, undefined, `${method} is not available`];
  } catch (err) {
    return [false, undefined, err instanceof Error ? err.message : String(err)];
  }
}

/** `PUT /api/runner/uploads/:id` from the runner that holds the ticket: stores the bytes. */
export async function completeUpload(
  ctx: Ctx,
  workstationId: string,
  uploadId: string,
  bytes: Buffer,
): Promise<CardAttachmentDto> {
  return withAppendTx(ctx.pool, async (tx) => {
    const up = await one(tx, 'SELECT * FROM card_attachment_uploads WHERE id=$1 FOR UPDATE', [uploadId]);
    if (!up || up.workstation_id !== workstationId) throw notFound('upload not found');
    if (new Date(up.expires_at) < ctx.clock.now()) {
      await exec(tx, 'DELETE FROM card_attachment_uploads WHERE id=$1', [uploadId]);
      throw conflict('upload_expired', 'the upload ticket expired: run the command again');
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== up.size || sha !== up.sha256)
      throw unprocessable('upload_mismatch', 'the file does not match what was announced');
    const card = await one(tx, 'SELECT * FROM cards WHERE id=$1', [up.card_id]);
    if (!card) throw notFound('card not found');
    const dto = await addAttachmentIn(
      ctx,
      tx,
      card,
      { kind: 'agent', agentId: up.agent_id },
      { name: up.name, bytes, source: up.source ?? undefined },
    );
    await exec(tx, 'DELETE FROM card_attachment_uploads WHERE id=$1', [uploadId]);
    return dto;
  });
}

/** `GET /api/runner/attachments/:id?shift=<id>`: a file of a card in the shift's reach. */
export async function readAttachmentForShift(
  ctx: Ctx,
  workstationId: string,
  shiftId: string,
  attachmentId: string,
): Promise<{ name: string; contentType: string; data: Buffer }> {
  const shift = await one(ctx.pool, 'SELECT * FROM shifts WHERE id=$1 AND workstation_id=$2', [
    shiftId,
    workstationId,
  ]);
  if (!shift) throw notFound('unknown shift');
  const a = await one(ctx.pool, 'SELECT card_id FROM card_attachments WHERE id=$1', [attachmentId]);
  if (!a) throw notFound('attachment not found');
  const scope = await agentScope(ctx, shift);
  if (!scope.cards.some((c) => c.id === a.card_id)) throw forbidden('this shift cannot read that attachment');
  return readAttachmentOf(ctx.pool, a.card_id, attachmentId);
}
