import { randomUUID } from 'node:crypto';
import {
  BA_ROLE_KEY,
  type CreateOutboundDraftRequest,
  DESK_SUBKIND,
  type ExternalRef,
  leakMessage,
  type OutboundAuthor,
  OutboundDraftRpcParamsSchema,
  type OutboundKind,
  parseExternalRef,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { loadManageable } from './cards.ts';
import { agentActor, cardMessage, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import type { RpcReply } from './intake.ts';
import { screenOutbound } from './leak-check.ts';
import { cardGoesThroughQa } from './qa-flow.ts';

const KIND_LABEL: Record<OutboundKind, string> = {
  comment: 'comment',
  resolution: 'resolution',
  decision: 'design decision',
};

/** The ticket a card came from (`fields.externalRef`), or null when it did not come from one. */
export function cardTicket(card: Row): ExternalRef | null {
  const raw = (card.fields as { externalRef?: unknown } | null)?.externalRef;
  return typeof raw === 'string' && raw.trim() ? parseExternalRef(raw) : null;
}

export type DraftOutcome =
  | {
      ok: true;
      draftId: string;
      /** Null while the draft is held for manual QA (no desk item yet). */
      deskItemId: string | null;
      ref: ExternalRef;
      duplicate: boolean;
      held?: boolean;
    }
  | { ok: false; error: string; blocked: boolean; matches: string[] };

export interface DraftInput {
  card: Row;
  kind: OutboundKind;
  body: string;
  author: OutboundAuthor;
  /** The BA drafts once per card and kind: asking again returns the draft that exists. */
  once?: boolean;
  /** Manual QA applies to the card: record the draft as held, with no desk item, until QA passes or is skipped. */
  hold?: boolean;
}

/** The desk approval for a drafted update (also used when a held draft is released after manual QA). */
export function outboundApprovalItem(input: {
  card: Row;
  ref: ExternalRef;
  kind: OutboundKind;
  body: string;
  author: OutboundAuthor;
  deskItemId: string;
}): AppendInput {
  const { card, ref, kind, body, author, deskItemId } = input;
  return {
    streamId: streamId.desk(deskItemId),
    event: {
      type: 'DeskItemCreated',
      payload: {
        deskItemId,
        kind: 'approval',
        subkind: DESK_SUBKIND.outbound,
        title: `Approve ${KIND_LABEL[kind]} for ${ref.system === 'jira' ? 'Jira' : 'GitHub'} ${ref.key}`,
        body,
        options: [],
        blocking: false,
        pinned: false,
        cardId: card.id,
        projectId: card.project_id,
        affectedCardIds: [card.id],
        askedBy: author.kind === 'agent' ? { kind: 'agent', agentId: author.agentId } : { kind: 'system' },
      },
    },
    actor: author.kind === 'agent' ? agentActor(author.agentId) : SYSTEM_ACTOR,
    scope: projectScope(card.org_id, card.project_id),
  };
}

/**
 * Manual QA passed or was skipped: every draft held for the card becomes a normal pending draft with its desk approval
 * (docs/design/manual-qa.md section 5). Returns the events to append with the QA decision.
 */
export async function releaseHeldDraftEvents(tx: Tx, card: Row): Promise<AppendInput[]> {
  const held = await rows(
    tx,
    `SELECT * FROM outbound_drafts WHERE card_id=$1 AND status='held' ORDER BY created_at FOR UPDATE`,
    [card.id],
  );
  const events: AppendInput[] = [];
  for (const d of held) {
    const deskItemId = randomUUID();
    const author: OutboundAuthor =
      d.drafted_by_kind === 'agent' && d.drafted_by_id
        ? { kind: 'agent', agentId: d.drafted_by_id }
        : d.drafted_by_kind === 'user' && d.drafted_by_id
          ? { kind: 'user', userId: d.drafted_by_id }
          : { kind: 'user', userId: card.owner_user_id };
    events.push(
      outboundApprovalItem({
        card,
        ref: {
          system: d.external_system,
          key: d.external_key,
          ...(d.external_url ? { url: d.external_url } : {}),
        },
        kind: d.kind,
        body: d.body,
        author,
        deskItemId,
      }),
      {
        streamId: streamId.outbound(d.id),
        event: { type: 'OutboundReleased', payload: { draftId: d.id, deskItemId } },
        actor: SYSTEM_ACTOR,
        scope: projectScope(card.org_id, card.project_id),
      },
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `The update for ${d.external_key} (${KIND_LABEL[d.kind as OutboundKind]}) is released and waiting for your approval on the desk.`,
      ),
    );
  }
  return events;
}

/**
 * Drafts an update for the card's ticket. A draft that names an agent or describes the team's inner workings is
 * recorded as blocked and never reaches the desk. Otherwise it lands on the desk as an approval for the card's owner
 * (docs/SPEC.md "External systems boundary"); nothing is posted until they approve.
 */
export async function draftOutboundIn(ctx: Ctx, tx: Tx, input: DraftInput): Promise<DraftOutcome> {
  const { card, kind, author } = input;
  const body = input.body.trim();
  const ref = cardTicket(card);
  if (!ref)
    return {
      ok: false,
      blocked: false,
      matches: [],
      error: `${card.ref} did not come from a ticket (its externalRef field is empty): there is nothing to update`,
    };
  if (input.once) {
    const existing = await one(
      tx,
      `SELECT id, desk_item_id FROM outbound_drafts
        WHERE card_id=$1 AND kind=$2 AND status IN ('held','pending','approved','posted') ORDER BY created_at LIMIT 1`,
      [card.id, kind],
    );
    if (existing)
      return {
        ok: true,
        draftId: existing.id,
        deskItemId: existing.desk_item_id ?? null,
        ref,
        duplicate: true,
        ...(existing.desk_item_id ? {} : { held: true }),
      };
  }
  const draftId = randomUUID();
  const scope = projectScope(card.org_id, card.project_id);
  const actor = author.kind === 'agent' ? agentActor(author.agentId) : userActor(author.userId);
  const leak = await screenOutbound(tx, card.org_id, body);
  // The manager's own text is refused on the spot; the BA's blocked draft is recorded so the card history shows it.
  if (!leak.ok && author.kind === 'user')
    return { ok: false, blocked: true, matches: leak.matches, error: leakMessage(leak.matches) };
  if (!leak.ok) {
    await ctx.store.append(
      [
        {
          streamId: streamId.outbound(draftId),
          event: {
            type: 'OutboundBlocked',
            payload: {
              draftId,
              cardId: card.id,
              externalSystem: ref.system,
              externalKey: ref.key,
              kind,
              body,
              matches: leak.matches,
              draftedBy: author,
            },
          },
          actor,
          scope,
        },
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          `A draft ${KIND_LABEL[kind]} for ${ref.key} was blocked: it mentioned internal details (${leak.matches.join(', ')}).`,
        ),
      ],
      { tx },
    );
    return { ok: false, blocked: true, matches: leak.matches, error: leakMessage(leak.matches) };
  }
  if (input.hold) {
    await ctx.store.append(
      [
        {
          streamId: streamId.outbound(draftId),
          event: {
            type: 'OutboundHeld',
            payload: {
              draftId,
              cardId: card.id,
              externalSystem: ref.system,
              externalKey: ref.key,
              ...(ref.url ? { externalUrl: ref.url } : {}),
              kind,
              body,
              draftedBy: author,
            },
          },
          actor,
          scope,
        },
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          `An update for ${ref.key} (${KIND_LABEL[kind]}) is ready. It is held until manual QA passes or is skipped; nothing is posted before then.`,
        ),
      ],
      { tx },
    );
    return { ok: true, draftId, deskItemId: null, ref, duplicate: false, held: true };
  }
  const deskItemId = randomUUID();
  const events: AppendInput[] = [
    outboundApprovalItem({ card, ref, kind, body, author, deskItemId }),
    {
      streamId: streamId.outbound(draftId),
      event: {
        type: 'OutboundDrafted',
        payload: {
          draftId,
          cardId: card.id,
          externalSystem: ref.system,
          externalKey: ref.key,
          ...(ref.url ? { externalUrl: ref.url } : {}),
          kind,
          body,
          deskItemId,
          draftedBy: author,
        },
      },
      actor,
      scope,
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `An update for ${ref.key} (${KIND_LABEL[kind]}) is waiting for your approval on the desk. Nothing is posted until you approve it.`,
    ),
  ];
  await ctx.store.append(events, { tx });
  return { ok: true, draftId, deskItemId, ref, duplicate: false };
}

/** `aom outbound draft` from the BA's card shift (the Finalize stage): a draft for the ticket the card came from. */
export async function outboundDraftRpc(
  ctx: Ctx,
  shift: Row,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const p = OutboundDraftRpcParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      'usage: aom outbound draft --kind <comment|resolution|decision> --body "<text>"',
    ];
  if (!shift.card_id || shift.kind !== 'card')
    return [false, undefined, 'drafting an update for a ticket is done in a card shift'];
  return withAppendTx(ctx.pool, async (tx): Promise<RpcReply> => {
    const agent = await one(tx, 'SELECT id, role_key FROM agents WHERE id=$1', [shift.agent_id]);
    if (agent?.role_key !== BA_ROLE_KEY)
      return [false, undefined, 'only the business analyst drafts updates for tickets'];
    const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [shift.card_id]);
    if (!card || card.claim_shift_id !== shift.id)
      return [false, undefined, 'this shift no longer holds the claim'];
    const r = await draftOutboundIn(ctx, tx, {
      card,
      kind: p.data.kind,
      body: p.data.body,
      author: { kind: 'agent', agentId: shift.agent_id },
      once: true,
      // Manual QA follows Finalize: the update is held until the person has tested (passed or skipped).
      hold: await cardGoesThroughQa(tx, card),
    });
    if (!r.ok) return [false, undefined, r.error];
    return [
      true,
      {
        draftId: r.draftId,
        message: r.duplicate
          ? `This card already has a ${p.data.kind} draft for ${r.ref.key}.`
          : r.held
            ? 'Drafted. It is held until the person who started the card has tested it (manual QA); then the manager approves, edits or rejects it on the desk. Nothing is posted before that. Continue with your finalize.'
            : `Drafted. The manager approves, edits or rejects it on the desk; nothing is posted before that. Continue with your finalize.`,
      },
    ];
  });
}

/** `POST /api/cards/:id/outbound`: the manager writes an update to the card's ticket themselves. */
export async function createManagerDraft(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  req: CreateOutboundDraftRequest,
): Promise<{ draftId: string }> {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, user, idOrRef);
    if (card.status === 'cancelled') throw conflict('card_cancelled', 'the card was cancelled');
    const r = await draftOutboundIn(ctx, tx, {
      card,
      kind: req.kind,
      body: req.body,
      author: { kind: 'user', userId: user.id },
    });
    if (!r.ok)
      throw unprocessable(r.blocked ? 'internal_details' : 'no_ticket', r.error, { matches: r.matches });
    return { draftId: r.draftId };
  });
}
