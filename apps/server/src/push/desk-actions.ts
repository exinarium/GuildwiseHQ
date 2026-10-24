import { randomUUID } from 'node:crypto';
import {
  DESK_ACTION_TOKEN_TTL_MS,
  type DeskActionApplied,
  type DeskActionKind,
  type DeskActionPreview,
  MAX_PUSH_ACTIONS,
  type PushAction,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import { signValue, verifySigned } from '../auth/secrets.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { projectRole } from '../authz/scope.ts';
import { orgScope, userActor } from '../commands/common.ts';
import { answerDeskItem, resolveDeskItem } from '../commands/desk.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { conflict, forbidden, gone, HttpError, notFound } from '../errors.ts';
import { canAnswerItem } from '../queries/desk.ts';
import { safeBody } from './text.ts';

const PURPOSE = 'desk-action';

/** Subkinds a one-tap action never covers: they need input of their own (a workstation, a card's own flow). */
const NO_QUICK_ACTION = new Set(['manual_qa', 'approval_step', 'playbook_workstation', 'ceo_decision']);

export interface QuickAction {
  kind: DeskActionKind;
  /** The notification button / confirm page label. */
  label: string;
}

interface Opt {
  id: string;
  label: string;
}

/** The one-tap actions an open desk item offers: Approve/Reject for an approval, the quick options of a question. Never more than the push API shows. */
export function quickActionsOf(item: Row): QuickAction[] {
  if (item.status !== 'open' || (item.subkind && NO_QUICK_ACTION.has(item.subkind))) return [];
  if (item.kind === 'approval') {
    // Approvals whose answer is a choice of their own (options) are decided on the Desk
    if (((item.options ?? []) as Opt[]).length > 0) return [];
    return [
      { kind: 'approve', label: 'Approve' },
      { kind: 'reject', label: 'Reject' },
    ];
  }
  if (item.kind === 'question') {
    const opts = ((item.options ?? []) as Opt[]).filter((o) => o?.id && o.label);
    // the recommended option first
    const rec = item.recommendation as string | null | undefined;
    opts.sort((a, b) => Number(b.id === rec) - Number(a.id === rec));
    return opts.slice(0, MAX_PUSH_ACTIONS).map((o) => ({
      kind: `option:${o.id}` as DeskActionKind,
      label: o.label.length > 36 ? `${o.label.slice(0, 35)}…` : o.label,
    }));
  }
  return [];
}

const mayAct = async (ctx: Ctx, userId: string, item: Row): Promise<boolean> => {
  const role = item.project_id ? await projectRole(ctx.pool, userId, item.project_id) : null;
  return canAnswerItem(item, userId, role, await orgRoleOf(ctx.pool, userId, item.org_id));
};

/** A signed, single-use token bound to the person, the item and the action; it opens the confirm page, it never applies anything. */
export async function issueDeskActionToken(
  ctx: Ctx,
  a: { orgId: string; userId: string; deskItemId: string; action: DeskActionKind },
): Promise<string> {
  const id = randomUUID();
  const now = ctx.clock.now();
  await ctx.pool.query(
    `INSERT INTO desk_action_tokens (id, org_id, user_id, desk_item_id, action, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, a.orgId, a.userId, a.deskItemId, a.action, now, new Date(now.getTime() + DESK_ACTION_TOKEN_TTL_MS)],
  );
  return signValue(ctx, PURPOSE, id);
}

/** The buttons of a desk push for one person (empty when the item has none or the person may not act on it). */
export async function pushActionsFor(ctx: Ctx, userId: string, itemId: string): Promise<PushAction[]> {
  const item = await one(
    ctx.pool,
    `SELECT d.*, c.owner_user_id AS card_owner, c.decision_policy AS card_policy
       FROM desk_items d LEFT JOIN cards c ON c.id = d.card_id WHERE d.id=$1`,
    [itemId],
  );
  if (!item) return [];
  const quick = quickActionsOf(item);
  if (quick.length === 0 || !(await mayAct(ctx, userId, item))) return [];
  const out: PushAction[] = [];
  for (const q of quick) {
    const token = await issueDeskActionToken(ctx, {
      orgId: item.org_id,
      userId,
      deskItemId: item.id,
      action: q.kind,
    });
    out.push({
      action: q.kind === 'approve' || q.kind === 'reject' ? q.kind : q.kind.slice('option:'.length),
      title: q.label,
      url: `/m/desk/${encodeURIComponent(token)}`,
    });
  }
  return out;
}

interface TokenRow extends Row {
  id: string;
  org_id: string;
  user_id: string;
  desk_item_id: string;
  action: DeskActionKind;
  expires_at: Date;
  used_at: Date | null;
}

async function loadToken(ctx: Ctx, token: string): Promise<TokenRow> {
  const id = await verifySigned(ctx, PURPOSE, token);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw notFound('this link is not valid', 'bad_token');
  const row = await one<TokenRow>(ctx.pool, 'SELECT * FROM desk_action_tokens WHERE id=$1', [id]);
  if (!row) throw notFound('this link is not valid', 'bad_token');
  return row;
}

const labelOf = (item: Row, action: DeskActionKind): string => {
  if (action === 'approve') return 'Approve';
  if (action === 'reject') return 'Reject';
  const id = action.slice('option:'.length);
  return ((item.options ?? []) as Opt[]).find((o) => o.id === id)?.label ?? 'Answer';
};

/** What the confirm page shows. Read-only: opening, prefetching or previewing a link never changes anything. */
export async function previewDeskAction(
  ctx: Ctx,
  user: AuthSession['user'],
  token: string,
): Promise<DeskActionPreview> {
  const t = await loadToken(ctx, token);
  if (t.user_id !== user.id)
    throw forbidden('this link was sent to another person: sign in as the person it was sent to');
  const item = await one(
    ctx.pool,
    `SELECT d.*, o.name AS org_name FROM desk_items d JOIN organizations o ON o.id = d.org_id WHERE d.id=$1`,
    [t.desk_item_id],
  );
  if (!item) throw notFound('desk item not found');
  const now = ctx.clock.now();
  const state: DeskActionPreview['state'] =
    t.used_at !== null
      ? 'used'
      : t.expires_at.getTime() <= now.getTime()
        ? 'expired'
        : item.status !== 'open'
          ? 'resolved'
          : 'ready';
  return {
    state,
    deskItemId: item.id,
    title: safeBody(item.title, 200),
    body: safeBody(item.body, 600),
    orgName: item.org_name,
    actionLabel: labelOf(item, t.action),
    action: t.action,
    expiresAt: t.expires_at.toISOString(),
  };
}

async function audit(
  ctx: Ctx,
  t: TokenRow,
  user: AuthSession['user'],
  outcome: 'applied' | 'refused',
  reason?: string,
): Promise<void> {
  await ctx.store.append([
    {
      streamId: streamId.desk(t.desk_item_id),
      event: {
        type: 'DeskNotificationActionTaken',
        payload: {
          orgId: t.org_id,
          deskItemId: t.desk_item_id,
          userId: t.user_id,
          action: t.action,
          outcome,
          ...(reason ? { reason } : {}),
          ...(user.id !== t.user_id ? { attemptedBy: user.id } : {}),
        },
      },
      actor: userActor(user.id),
      scope: orgScope(t.org_id),
    },
  ]);
}

/**
 * Applies the action of a link (POST only). The signed-in person must be the one the link was made for; the token is spent
 * first (an atomic update), so two taps or a replay apply once at most. Every outcome, applied or refused, is an audit event.
 */
export async function applyDeskAction(
  ctx: Ctx,
  user: AuthSession['user'],
  token: string,
): Promise<DeskActionApplied> {
  const t = await loadToken(ctx, token);
  const refuse = async (code: string, err: HttpError): Promise<never> => {
    await audit(ctx, t, user, 'refused', code).catch((e) => ctx.log.warn({ err: e }, 'audit failed'));
    throw err;
  };
  if (t.user_id !== user.id)
    return refuse(
      'wrong_user',
      forbidden('this link was sent to another person: sign in as the person it was sent to'),
    );
  if (t.expires_at.getTime() <= ctx.clock.now().getTime())
    return refuse('expired', gone('expired', 'this link expired: open the Desk to decide'));
  // spend it: only one request can flip used_at
  const spent = await ctx.pool.query(
    `UPDATE desk_action_tokens SET used_at=$2 WHERE id=$1 AND used_at IS NULL AND expires_at > $2`,
    [t.id, ctx.clock.now()],
  );
  if (!spent.rowCount)
    return refuse('used', conflict('link_used', 'this link was already used: open the Desk to see the item'));
  const item = await one(ctx.pool, 'SELECT * FROM desk_items WHERE id=$1', [t.desk_item_id]);
  if (!item) return refuse('missing', notFound('desk item not found'));
  const label = labelOf(item, t.action);
  try {
    if (t.action === 'approve' || t.action === 'reject') {
      await resolveDeskItem(ctx, user, item.id, {
        resolution: t.action === 'approve' ? 'approved' : 'rejected',
        note: 'From the notification',
      });
    } else {
      await answerDeskItem(ctx, user, item.id, {
        answer: label,
        optionId: t.action.slice('option:'.length),
        ledger: { scope: 'decision' },
      });
    }
  } catch (err) {
    const reason = err instanceof HttpError ? err.code : 'error';
    await audit(ctx, t, user, 'refused', reason).catch((e) => ctx.log.warn({ err: e }, 'audit failed'));
    // an unexpected failure gives the tap back; a refusal (already decided, not allowed) stays spent
    if (!(err instanceof HttpError))
      await ctx.pool.query('UPDATE desk_action_tokens SET used_at=NULL WHERE id=$1', [t.id]);
    throw err;
  }
  await audit(ctx, t, user, 'applied');
  return {
    deskItemId: item.id,
    outcome: t.action === 'approve' ? 'approved' : t.action === 'reject' ? 'rejected' : 'answered',
    actionLabel: label,
  };
}

/** Spent and expired tokens older than a day go (a housekeeping pass). */
export async function sweepDeskActionTokens(ctx: Ctx): Promise<number> {
  const r = await ctx.pool.query(`DELETE FROM desk_action_tokens WHERE expires_at < $1`, [
    new Date(ctx.clock.now().getTime() - 24 * 3600_000),
  ]);
  return r.rowCount ?? 0;
}
