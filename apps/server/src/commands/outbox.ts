import { randomUUID } from 'node:crypto';
import {
  DESK_SUBKIND,
  leakMessage,
  type OutboundDraftDto,
  type OutboundPostPayload,
  OutboundPostResultSchema,
  type OutboundStatus,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { completeCommand, enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { orgAgentNames, screenOutbound } from './leak-check.ts';

/**
 * The outbox (docs/SPEC.md "External systems boundary"; docs/ARCHITECTURE.md section 16.5). A draft the card's owner
 * approved becomes an `outbound.post` command for one of the owner's own workstations: their Jira and GitHub
 * credentials exist nowhere else, so nobody else's runner (and not the server) ever posts on their behalf. With no
 * workstation of theirs online the command waits in the durable queue; with none at all the draft stays `approved`
 * and is queued when one connects.
 */

/** The owner's workstation to post from: a connected one first, else the most recently seen. */
export async function ownerWorkstation(db: Queryable, ownerId: string): Promise<string | null> {
  const w = await one(
    db,
    `SELECT id FROM workstations WHERE user_id=$1 AND status='active'
      ORDER BY connected DESC, last_seen_at DESC NULLS LAST, paired_at LIMIT 1`,
    [ownerId],
  );
  return w?.id ?? null;
}

const hasOpenCommand = async (db: Queryable, draftId: string): Promise<boolean> =>
  !!(await one(
    db,
    `SELECT 1 FROM runner_commands WHERE type='outbound.post' AND status IN ('pending','sent') AND payload->>'draftId'=$1 LIMIT 1`,
    [draftId],
  ));

/** Queues `outbound.post` for an approved draft; returns the workstation, or null when nothing was queued. */
export async function queueOutboundPost(tx: Tx, draft: Row, toWorkstation?: string): Promise<string | null> {
  if (draft.status !== 'approved' || !draft.final_body) return null;
  if (await hasOpenCommand(tx, draft.id)) return null;
  const card = (await one(tx, 'SELECT id, ref, owner_user_id FROM cards WHERE id=$1', [
    draft.card_id,
  ])) as Row;
  const ws = toWorkstation ?? (await ownerWorkstation(tx, card.owner_user_id));
  if (!ws) return null;
  const payload: OutboundPostPayload = {
    draftId: draft.id,
    cardId: card.id,
    cardRef: card.ref,
    ref: {
      system: draft.external_system,
      key: draft.external_key,
      ...(draft.external_url ? { url: draft.external_url } : {}),
    },
    kind: draft.kind,
    body: draft.final_body,
    agentNames: await orgAgentNames(tx, draft.org_id),
  };
  await enqueueRunnerCommand(tx, ws, 'outbound.post', payload as never);
  return ws;
}

/**
 * Desk resolution of an outbound approval (called inside the desk resolve transaction). Only the card's owner decides
 * (the owner posts with their own access). Approve posts the text as it stands, edited or not; reject (or dismiss)
 * means it is never posted. An edit goes through the leak check again.
 */
export async function resolveOutboundIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  item: Row,
  resolution: 'approved' | 'rejected' | 'acknowledged' | 'dismissed',
  note?: string,
  editedBody?: string,
): Promise<string | null> {
  if (resolution === 'acknowledged')
    throw badRequest('wrong_resolution', 'an outbound update is approved or rejected');
  const draft = await one(tx, 'SELECT * FROM outbound_drafts WHERE desk_item_id=$1 FOR UPDATE', [item.id]);
  if (!draft) throw notFound('outbound draft not found');
  if (item.card_owner !== user.id)
    throw forbidden('only the card owner can approve updates to the ticket: they post with their own access');
  if (draft.status !== 'pending') throw conflict('already_decided', `this draft is already ${draft.status}`);
  const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [draft.card_id])) as Row;
  const scope = projectScope(card.org_id, card.project_id);
  const events: AppendInput[] = [];
  if (resolution === 'rejected' || resolution === 'dismissed') {
    events.push(
      {
        streamId: streamId.outbound(draft.id),
        event: {
          type: 'OutboundRejected',
          payload: { draftId: draft.id, by: user.id, ...(note ? { reason: note } : {}) },
        },
        actor: userActor(user.id),
        scope,
      },
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `The update for ${draft.external_key} was rejected and will not be posted.`,
      ),
    );
    await ctx.store.append(events, { tx });
    return null;
  }
  const edited = editedBody !== undefined && editedBody.trim() !== draft.body.trim();
  const finalBody = (editedBody ?? draft.body).trim();
  if (!finalBody) throw badRequest('empty_body', 'the update is empty');
  if (edited) {
    const leak = await screenOutbound(tx, card.org_id, finalBody);
    if (!leak.ok)
      throw unprocessable('internal_details', leakMessage(leak.matches), { matches: leak.matches });
  }
  await ctx.store.append(
    [
      {
        streamId: streamId.outbound(draft.id),
        event: {
          type: 'OutboundApproved',
          payload: { draftId: draft.id, finalBody, approvedBy: user.id, edited },
        },
        actor: userActor(user.id),
        scope,
      },
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `The update for ${draft.external_key} was approved${edited ? ' (edited)' : ''}; your workstation posts it.`,
      ),
    ],
    { tx },
  );
  return queueOutboundPost(tx, { ...draft, status: 'approved', final_body: finalBody });
}

/**
 * The runner's answer to `outbound.post`. Only the card owner's workstation counts, and only for a draft that is still
 * approved (a repeated answer changes nothing). A failure lands on the desk as an alert.
 */
export async function applyOutboundResult(
  ctx: Ctx,
  workstationId: string,
  draftId: string,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const parsed = OutboundPostResultSchema.safeParse(result);
  const r = parsed.success ? parsed.data : { ok: false as const };
  const success = ok && r.ok;
  const failure = r.error ?? error ?? 'the update could not be posted';
  await withAppendTx(ctx.pool, async (tx) => {
    const draft = await one(tx, 'SELECT * FROM outbound_drafts WHERE id=$1 FOR UPDATE', [draftId]);
    if (!draft || draft.status !== 'approved') return;
    const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [draft.card_id])) as Row;
    const ws = await one(tx, 'SELECT user_id FROM workstations WHERE id=$1', [workstationId]);
    if (!ws || ws.user_id !== card.owner_user_id) return;
    const scope = projectScope(card.org_id, card.project_id);
    const where = `${draft.external_system === 'jira' ? 'Jira' : 'GitHub'} ${draft.external_key}`;
    if (success) {
      await ctx.store.append(
        [
          {
            streamId: streamId.outbound(draft.id),
            event: {
              type: 'OutboundPosted',
              payload: { draftId: draft.id, ...(r.externalRef ? { externalRef: r.externalRef } : {}) },
            },
            actor: SYSTEM_ACTOR,
            scope,
          },
          cardMessage(
            card,
            { kind: 'system' },
            'system',
            `Posted to ${where}${r.externalRef ? `: ${r.externalRef}` : ''}.`,
            { draftId: draft.id, ...(r.externalRef ? { externalRef: r.externalRef } : {}) },
          ),
        ],
        { tx },
      );
      return;
    }
    const alertId = randomUUID();
    await ctx.store.append(
      [
        {
          streamId: streamId.desk(alertId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId: alertId,
              kind: 'alert',
              subkind: DESK_SUBKIND.outboundFailed,
              title: `Could not post the update to ${where}`,
              body: `${failure}\n\nThe approved text is kept. Retry it from the card's updates once this is fixed.`,
              options: [],
              blocking: false,
              pinned: false,
              cardId: card.id,
              projectId: card.project_id,
              affectedCardIds: [card.id],
              askedBy: { kind: 'system' },
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        {
          streamId: streamId.outbound(draft.id),
          event: {
            type: 'OutboundPostFailed',
            payload: { draftId: draft.id, error: failure.slice(0, 4000), alertDeskItemId: alertId },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        cardMessage(card, { kind: 'system' }, 'system', `Posting to ${where} failed: ${failure}`),
      ],
      { tx },
    );
  });
}

/** `POST /api/outbound/:id/retry`: the owner posts a failed update again. Returns the workstation to deliver to. */
export async function retryOutbound(
  ctx: Ctx,
  user: AuthSession['user'],
  id: string,
): Promise<{ workstationId: string | null }> {
  return withAppendTx(ctx.pool, async (tx) => {
    const draft = await one(tx, 'SELECT * FROM outbound_drafts WHERE id=$1 FOR UPDATE', [id]);
    if (!draft) throw notFound('outbound draft not found');
    const { card } = await loadVisibleCard(tx, user.id, draft.card_id);
    if (card.owner_user_id !== user.id) throw forbidden('only the card owner can post updates to the ticket');
    if (draft.status !== 'failed') throw conflict('not_failed', `this draft is ${draft.status}, not failed`);
    const scope = projectScope(card.org_id, card.project_id);
    const events: AppendInput[] = [
      {
        streamId: streamId.outbound(draft.id),
        event: { type: 'OutboundRetryRequested', payload: { draftId: draft.id, by: user.id } },
        actor: userActor(user.id),
        scope,
      },
    ];
    // The failure alert is done with once the owner retries.
    if (draft.desk_item_id) {
      const alert = await one(
        tx,
        `SELECT id FROM desk_items WHERE id=$1 AND status='open' AND kind='alert'`,
        [draft.desk_item_id],
      );
      if (alert)
        events.push({
          streamId: streamId.desk(alert.id),
          event: {
            type: 'DeskItemResolved',
            payload: {
              deskItemId: alert.id,
              resolution: 'acknowledged',
              note: 'Retried',
              by: { kind: 'user', userId: user.id },
            },
          },
          actor: userActor(user.id),
          scope,
        });
    }
    await ctx.store.append(events, { tx });
    return { workstationId: await queueOutboundPost(tx, { ...draft, status: 'approved' }) };
  });
}

/**
 * A workstation of `userId` connected: approved drafts of that user's cards that never got a command (the user had no
 * workstation when they approved) are queued for it.
 */
export async function queueApprovedFor(ctx: Ctx, userId: string, workstationId: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const pending = await rows(
      tx,
      `SELECT d.* FROM outbound_drafts d JOIN cards c ON c.id = d.card_id
        WHERE d.status='approved' AND c.owner_user_id=$1 ORDER BY d.approved_at`,
      [userId],
    );
    for (const d of pending) await queueOutboundPost(tx, d, workstationId);
  });
}

/** Marks the command done once the result is applied (the command is terminal: a failure is a desk alert, not a retry). */
export async function finishOutboundCommand(ctx: Ctx, commandId: string): Promise<void> {
  await completeCommand(ctx.pool, commandId, true, undefined, ctx.clock.now());
}

// ----------------------------------------------------------------------------------------------- queries

const SELECT = `
SELECT d.*, c.ref AS card_ref, c.title AS card_title, p.key AS project_key,
       ua.display_name AS drafted_by_user, aa.name AS drafted_by_agent, ap.display_name AS approved_by_name
  FROM outbound_drafts d
  JOIN cards c ON c.id = d.card_id
  JOIN projects p ON p.id = d.project_id
  LEFT JOIN users ua ON d.drafted_by_kind = 'user' AND ua.id = d.drafted_by_id
  LEFT JOIN agents aa ON d.drafted_by_kind = 'agent' AND aa.id = d.drafted_by_id
  LEFT JOIN users ap ON ap.id = d.approved_by`;

function toDto(r: Row): OutboundDraftDto {
  return {
    id: r.id,
    cardId: r.card_id,
    cardRef: r.card_ref,
    cardTitle: r.card_title,
    projectKey: r.project_key,
    externalSystem: r.external_system,
    externalKey: r.external_key,
    kind: r.kind,
    body: r.body,
    finalBody: r.final_body,
    edited: r.edited,
    status: r.status,
    deskItemId: r.desk_item_id,
    draftedByName: r.drafted_by_agent ?? r.drafted_by_user ?? null,
    approvedByName: r.approved_by_name,
    externalRef: r.external_ref,
    error: r.error,
    blockedMatches: r.blocked_matches ?? [],
    rejectReason: r.reject_reason,
    createdAt: iso(r.created_at) as string,
    approvedAt: iso(r.approved_at),
    postedAt: iso(r.posted_at),
  };
}

/** Drafts of the projects the user belongs to, newest first (optionally one card's history, or one status). */
export async function listOutbound(
  db: Queryable,
  user: { id: string },
  q: { card?: string | undefined; status?: OutboundStatus | undefined },
): Promise<OutboundDraftDto[]> {
  let cardId: string | null = null;
  if (q.card) cardId = (await loadVisibleCard(db, user.id, q.card)).card.id;
  const list = await rows(
    db,
    `${SELECT}
      WHERE d.project_id IN (SELECT project_id FROM project_members WHERE user_id=$1 AND status='active')
        AND ($2::uuid IS NULL OR d.card_id = $2) AND ($3::text IS NULL OR d.status = $3)
      ORDER BY d.created_at DESC, d.id LIMIT 200`,
    [user.id, cardId, q.status ?? null],
  );
  return list.map(toDto);
}

export async function getOutboundDto(db: Queryable, id: string): Promise<OutboundDraftDto> {
  const r = await one(db, `${SELECT} WHERE d.id = $1`, [id]);
  if (!r) throw notFound('outbound draft not found');
  return toDto(r);
}
