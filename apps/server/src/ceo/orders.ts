import { createHash, randomUUID } from 'node:crypto';
import {
  type AuthorizeStandingOrderRequest,
  type LedgerEntryDto,
  OWNER_RESERVED_KEYS,
  renderCeoData,
  streamId,
  rewordForOrg,
} from '@aom/shared';
import { orgOwnerId, orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { orgScope, projectScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';

/**
 * Standing orders with full power (docs/design/ceo-front-door.md section 3.4). The Owner marks one of his own standing
 * orders "the CEO enforces this with full power"; the mark is pinned to the exact wording by hash. Authorship alone never
 * grants it (docs/design 0.2), and an Admin's order only after he escalated it and the Owner marked it as his own (section
 * 14.4).
 */

/** The wording an authorization is pinned to: sha256 of the title, a newline and the text. */
export const orderVersionHash = (title: string, body: string): string =>
  createHash('sha256').update(`${title}\n${body}`).digest('hex');

/** The same hash in SQL (Postgres 11+): the live wording of a `ledger_entries` row `l`. */
export const LIVE_HASH_SQL = `encode(sha256(convert_to(l.title || E'\\n' || l.body, 'UTF8')), 'hex')`;

export interface Eligibility {
  eligible: boolean;
  reason: string | null;
  escalated: boolean;
}

/**
 * May the Owner mark this order? It is his own (written by him in his session, not by the CEO), or the Owner approved the
 * proposal on the desk, or an Admin escalated it to him. Admin-written orders and vault text never qualify by themselves.
 */
export async function orderEligibility(db: Queryable, entry: Row, ownerId: string): Promise<Eligibility> {
  const auth = await one(
    db,
    'SELECT escalated_at FROM standing_order_authority WHERE entry_id=$1 AND escalated_at IS NOT NULL',
    [entry.id],
  );
  const escalated = !!auth;
  if (entry.scope !== 'standing_order')
    return { eligible: false, reason: 'only standing orders can carry full power', escalated };
  if (entry.retired_at || entry.superseded_by)
    return { eligible: false, reason: 'this order is retired', escalated };
  if (escalated) return { eligible: true, reason: null, escalated };
  if (entry.created_by_kind === 'user' && entry.created_by_id === ownerId) {
    // Written in the Owner's own session: no CEO action stands behind the event that created it.
    const caused = await one(
      db,
      `SELECT 1 FROM events WHERE stream_id=$1 AND type='LedgerEntryAdded' AND causation_id IS NOT NULL LIMIT 1`,
      [streamId.ledger(entry.id)],
    );
    if (!caused) return { eligible: true, reason: null, escalated };
    return {
      eligible: false,
      reason: 'the CEO created this order: approve it on the desk first, then mark it',
      escalated,
    };
  }
  if (entry.source_desk_item_id) {
    const d = await one(db, `SELECT answered_by, status FROM desk_items WHERE id=$1 AND org_id=$2`, [
      entry.source_desk_item_id,
      entry.org_id,
    ]);
    if (d?.answered_by === ownerId) return { eligible: true, reason: null, escalated };
  }
  if (entry.created_by_kind === 'user')
    return {
      eligible: false,
      reason:
        'an Admin wrote this order: ask the Owner to take it over (Escalate), who can then mark it as his own',
      escalated,
    };
  return {
    eligible: false,
    reason: 'this order was proposed by an agent: the Owner approves it on the desk first',
    escalated,
  };
}

export interface Authority {
  entryId: string;
  versionHash: string;
  scope: { projectIds: string[] | null; triggers?: string[] };
  covers: string[];
  authorizedAt: Date;
}

/** The authority of an order when it is in force: authorized, not voided or revoked, and the live wording still hashes the same. */
export async function currentAuthority(db: Queryable, entryId: string): Promise<Authority | undefined> {
  const r = await one(
    db,
    `SELECT a.*, ${LIVE_HASH_SQL} AS live_hash, l.retired_at, l.superseded_by
       FROM standing_order_authority a JOIN ledger_entries l ON l.id = a.entry_id
      WHERE a.entry_id=$1 AND a.version_hash IS NOT NULL AND a.voided_at IS NULL AND a.revoked_at IS NULL`,
    [entryId],
  );
  if (!r || r.retired_at || r.superseded_by || r.live_hash !== r.version_hash) return undefined;
  return {
    entryId,
    versionHash: r.version_hash,
    scope: r.scope ?? { projectIds: null },
    covers: r.covers ?? [],
    authorizedAt: new Date(r.authorized_at),
  };
}

/** The `fullPower` block of a ledger entry for the web. */
export async function fullPowerDto(
  db: Queryable,
  entry: Row,
  ownerId: string | null,
): Promise<NonNullable<LedgerEntryDto['fullPower']>> {
  if (entry.scope !== 'standing_order')
    return {
      state: 'none',
      versionHash: null,
      current: false,
      scope: null,
      covers: [],
      authorizedAt: null,
      voidReason: null,
      eligible: false,
      ineligibleReason: null,
      escalated: false,
    };
  const a = await one(db, 'SELECT * FROM standing_order_authority WHERE entry_id=$1', [entry.id]);
  const el = ownerId
    ? await orderEligibility(db, entry, ownerId)
    : { eligible: false, reason: null, escalated: !!a?.escalated_at };
  const authorized = !!a?.version_hash;
  const live = authorized ? orderVersionHash(entry.title, entry.body) : null;
  const state: 'none' | 'authorized' | 'voided' | 'revoked' = !authorized
    ? 'none'
    : a.revoked_at
      ? 'revoked'
      : a.voided_at || (live !== null && live !== a.version_hash)
        ? 'voided'
        : 'authorized';
  return {
    state,
    // The live wording's hash: what an authorization would pin now (the web sends it back to prove what the Owner read).
    versionHash: orderVersionHash(entry.title, entry.body),
    current: state === 'authorized',
    scope: authorized ? (a.scope ?? { projectIds: null }) : null,
    covers: authorized ? (a.covers ?? []) : [],
    authorizedAt: a?.authorized_at ? new Date(a.authorized_at).toISOString() : null,
    voidReason: a?.void_reason ?? (state === 'voided' ? 'edited' : null),
    eligible: el.eligible,
    ineligibleReason: el.reason,
    escalated: el.escalated,
  };
}

/** Events that void an order's authority when its wording changed or it was retired (empty when it has none in force). */
export async function voidAuthorityEvents(
  db: Queryable,
  entryId: string,
  reason: 'edited' | 'retired' | 'owner_changed',
  scope: AppendInput['scope'],
): Promise<AppendInput[]> {
  const a = await one(
    db,
    `SELECT 1 FROM standing_order_authority WHERE entry_id=$1 AND version_hash IS NOT NULL AND voided_at IS NULL AND revoked_at IS NULL`,
    [entryId],
  );
  if (!a) return [];
  return [
    {
      streamId: streamId.ledger(entryId),
      event: { type: 'StandingOrderAuthorityVoided', payload: { entryId, reason } },
      actor: SYSTEM_ACTOR,
      scope,
    },
  ];
}

async function lockOrder(tx: Queryable, entryId: string): Promise<Row> {
  const e = await one(tx, 'SELECT * FROM ledger_entries WHERE id=$1 FOR UPDATE', [entryId]);
  if (!e) throw notFound('ledger entry not found');
  return e;
}

const entryScope = (e: Row) => (e.project_id ? projectScope(e.org_id, e.project_id) : orgScope(e.org_id));

/** `POST /api/ledger/:id/authorize` (Owner only, session-authenticated, never a CEO verb). */
export async function authorizeOrder(
  ctx: Ctx,
  user: AuthSession['user'],
  entryId: string,
  req: AuthorizeStandingOrderRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const e = await lockOrder(tx, entryId);
    if ((await orgRoleOf(tx, user.id, e.org_id)) !== 'owner')
      throw forbidden('only the organization Owner can give the CEO full power on an order');
    const owner = await orgOwnerId(tx, e.org_id);
    const el = await orderEligibility(tx, e, owner);
    if (!el.eligible) throw conflict('not_eligible', el.reason ?? 'this order cannot carry full power');
    const live = orderVersionHash(e.title, e.body);
    if (req.versionHash !== live)
      throw conflict(
        'stale_wording',
        'the order was edited since you opened it: read it again, then mark it',
      );
    const bad = req.covers.filter((k) => !(OWNER_RESERVED_KEYS as readonly string[]).includes(k));
    if (bad.length) throw badRequest('unknown_cover', `unknown owner-reserved key: ${bad.join(', ')}`);
    const projectIds = req.scope.projectIds;
    if (projectIds?.length) {
      const known = await rows(tx, 'SELECT id FROM projects WHERE org_id=$1 AND id = ANY($2::uuid[])', [
        e.org_id,
        projectIds,
      ]);
      if (known.length !== new Set(projectIds).size)
        throw badRequest('unknown_project', 'a project in the scope does not belong to this organization');
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.ledger(entryId),
          event: {
            type: 'StandingOrderAuthorized',
            payload: {
              entryId,
              orgId: e.org_id,
              versionHash: live,
              by: user.id,
              scope: {
                projectIds: projectIds?.length ? projectIds : null,
                ...(req.scope.triggers?.length ? { triggers: req.scope.triggers } : {}),
              },
              covers: req.covers,
            },
          },
          actor: userActor(user.id),
          scope: entryScope(e),
        },
      ],
      { tx },
    );
  });
}

/** One click: the order no longer carries full power. */
export async function revokeOrder(ctx: Ctx, user: AuthSession['user'], entryId: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const e = await lockOrder(tx, entryId);
    if ((await orgRoleOf(tx, user.id, e.org_id)) !== 'owner')
      throw forbidden('only the organization Owner can revoke full power');
    const a = await one(
      tx,
      'SELECT 1 FROM standing_order_authority WHERE entry_id=$1 AND version_hash IS NOT NULL AND revoked_at IS NULL',
      [entryId],
    );
    if (!a) throw conflict('not_authorized', 'this order does not carry full power');
    await ctx.store.append(
      [
        {
          streamId: streamId.ledger(entryId),
          event: { type: 'StandingOrderAuthorityRevoked', payload: { entryId, by: user.id } },
          actor: userActor(user.id),
          scope: entryScope(e),
        },
      ],
      { tx },
    );
  });
}

/** An Admin asks the Owner to take an order over: the order stays the Admin's until the Owner marks it (section 14.4). */
export async function escalateOrder(
  ctx: Ctx,
  user: AuthSession['user'],
  entryId: string,
  note: string,
): Promise<void> {
  const e0 = await one(ctx.pool, 'SELECT * FROM ledger_entries WHERE id=$1', [entryId]);
  if (!e0) throw notFound('ledger entry not found');
  const role = await orgRoleOf(ctx.pool, user.id, e0.org_id);
  if (role !== 'owner' && role !== 'admin')
    throw forbidden('only the organization Owner and Admins can escalate an order');
  if (e0.scope !== 'standing_order' || e0.retired_at || e0.superseded_by)
    throw conflict('not_escalatable', 'only a live standing order can be escalated');
  const deskItemId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    const e = await lockOrder(tx, entryId);
    const ownerId = await orgOwnerId(tx, e.org_id);
    const orgMode = await one(tx, 'SELECT mode FROM organizations WHERE id=$1', [e.org_id]);
    const events: AppendInput[] = [
      {
        streamId: streamId.ledger(entryId),
        event: {
          type: 'StandingOrderEscalated',
          payload: { entryId, orgId: e.org_id, by: user.id, note, deskItemId },
        },
        actor: userActor(user.id),
        scope: entryScope(e),
      },
    ];
    events.push({
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: 'order_escalation',
          title: `${rewordForOrg('Take over this standing order as your own?', orgMode?.mode)} ${String(e.title).slice(0, 120)}`,
          body: `${(await one(tx, 'SELECT display_name FROM users WHERE id=$1', [user.id]))?.display_name ?? 'An Admin'} ${rewordForOrg('asks you to take over the standing order', orgMode?.mode)} "${e.title}". ${rewordForOrg('Only you can let the CEO enforce an order with full power. Open the Ledger, read the order, and mark it as yours.', orgMode?.mode)}${note ? `\n\nTheir note: ${note}` : ''}`,
          options: [],
          blocking: false,
          pinned: false,
          affectedCardIds: [],
          askedBy: { kind: 'user', userId: user.id },
          addresseeUserId: ownerId,
          subjectKey: `order_escalation:${entryId}`,
          data: { entryId },
        },
      },
      actor: userActor(user.id),
      scope: entryScope(e),
    });
    await ctx.store.append(events, { tx });
  });
}

/** An order in force, for the CEO's brief (title, id, scope, a one-line summary). */
export interface BriefOrder {
  entryId: string;
  title: string;
  scope: { projectIds: string[] | null; triggers?: string[] };
  covers: string[];
  summary: string;
}

export async function authorizedOrders(db: Queryable, orgId: string): Promise<BriefOrder[]> {
  const list = await rows(
    db,
    `SELECT l.id, l.title, l.body, a.scope, a.covers
       FROM standing_order_authority a JOIN ledger_entries l ON l.id = a.entry_id
      WHERE a.org_id=$1 AND a.version_hash IS NOT NULL AND a.voided_at IS NULL AND a.revoked_at IS NULL
        AND l.retired_at IS NULL AND l.superseded_by IS NULL AND a.version_hash = ${LIVE_HASH_SQL}
      ORDER BY l.created_at`,
    [orgId],
  );
  return list.map((r) => ({
    entryId: r.id,
    title: r.title,
    scope: r.scope ?? { projectIds: null },
    covers: r.covers ?? [],
    summary: String(r.body).replace(/\s+/g, ' ').slice(0, 160),
  }));
}

/** The authorized orders as the restricted wake brief lists them (3.4.1). */
export async function ordersBriefSection(db: Queryable, orgId: string): Promise<string | undefined> {
  const orders = await authorizedOrders(db, orgId);
  if (!orders.length) return undefined;
  const lines = orders.map(
    (o) =>
      `- order ${o.entryId}: ${o.title}${o.scope.projectIds ? ` (projects ${o.scope.projectIds.length})` : ''}${o.scope.triggers?.length ? ` [triggers: ${o.scope.triggers.join(', ')}]` : ''}: ${o.summary}`,
  );
  return [
    '## Orders the owner authorized for full power',
    'When an event clearly falls under one of these, invoke it: `aom ceo order invoke <id> --wake <wake id> --why "<how this event falls under the order>" --confidence <0..1>`. The server then starts a separate full-power turn that enforces that order and nothing else. When you are unsure the event fits, stay restricted and ask: `aom ceo notify --kind needs_you`, naming the order.',
    renderCeoData('Authorized orders (titles and text come from the owner)', lines.join('\n')),
  ].join('\n');
}
