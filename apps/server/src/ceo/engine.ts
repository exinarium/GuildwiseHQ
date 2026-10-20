import { createHash, randomUUID } from 'node:crypto';
import {
  type CeoActionMode,
  type CeoActionName,
  type CeoInverse,
  type CeoRpc,
  evaluatePolicy,
  type PolicyVerdict,
  streamId,
} from '@aom/shared';
import { orgOwnerId } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { agentActor, orgScope } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { subjectProjectPaused } from '../dispatcher/project-hold.ts';
import { HttpError } from '../errors.ts';
import { withActingAgent } from '../eventstore/acting.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { ceoBy } from './actions.ts';
import { ceoDecisionItemEvents, REVIEWED_CLASSES } from './decisions.ts';
import { ACTIONS } from './registry.ts';
import type { CeoState } from './state.ts';
import type { ActionDef, ActionEnv, Executed, Prepared } from './types.ts';

type ActRpc = Extract<CeoRpc, { op: 'act' }>;

/** The organization Owner as the principal whose rights the CEO borrows. */
export async function ownerPrincipal(ctx: Ctx, orgId: string): Promise<AuthSession['user']> {
  const id = await orgOwnerId(ctx.pool, orgId);
  const u = await one(ctx.pool, 'SELECT id, email, display_name FROM users WHERE id=$1', [id]);
  return { id, email: u?.email ?? '', displayName: u?.display_name ?? 'Owner' } as AuthSession['user'];
}

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );

/** The provenance of a call; a call without one is a chat call (the owner) when it has a thread, else a wake. */
export const originKind = (o: CallOrigin): 'owner' | 'order' | 'wake' =>
  o.kind ?? (o.chatThreadId ? 'owner' : 'wake');

export const defaultKey = (scopeId: string, action: string, params: unknown): string =>
  createHash('sha256')
    .update(`${scopeId}|${action}|${canon(params)}`)
    .digest('hex')
    .slice(0, 40);

export interface EngineResult {
  status: 'executed' | 'recommended' | 'refused' | 'dry_run' | 'duplicate';
  message: string;
  actionId?: string;
  mode?: CeoActionMode;
  deskItemId?: string;
  wouldBe?: CeoActionMode;
  result?: unknown;
}

/** Where a call comes from: a wake shift (outside text may have caused it) or the owner's chat. */
export interface CallOrigin {
  /** Where the call comes from (docs/design/ceo-front-door.md section 3): decided by the server from its own records. */
  kind?: 'owner' | 'order' | 'wake' | undefined;
  scopeId: string;
  batchId?: string | undefined;
  chatThreadId?: string | undefined;
  /** The owner or order turn (`ceo_turns`) the call belongs to. */
  turnId?: string | undefined;
  /** An order turn: the Owner-authorized standing order it enforces, its pinned wording and what it covers. */
  order?: { entryId: string; versionHash: string; covers: string[] } | undefined;
  untrusted: boolean;
  /** An owner-pressed Accept: the policy was the owner's own decision. */
  acceptedFrom?: string | undefined;
}

const inflight = new Set<string>();

/** How many valid evidence ids the call cites (ledger entries, active owner memories). */
async function evidenceFound(ctx: Ctx, orgId: string, ids: string[]): Promise<number> {
  let n = 0;
  for (const raw of ids) {
    const [kind, id] = raw.split(':');
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) continue;
    if (kind === 'ledger') {
      const r = await one(
        ctx.pool,
        `SELECT 1 FROM ledger_entries l WHERE l.id=$1 AND (l.org_id=$2 OR l.project_id IN (SELECT id FROM projects WHERE org_id=$2))`,
        [id, orgId],
      );
      if (r) n++;
    } else if (kind === 'memory') {
      const r = await one(
        ctx.pool,
        `SELECT 1 FROM ceo_memories WHERE id=$1 AND org_id=$2 AND status='active'`,
        [id, orgId],
      );
      if (r) n++;
    }
  }
  return n;
}

async function genericLimit(env: ActionEnv, cls: string, prepared: Prepared): Promise<string | undefined> {
  const lim = env.ceo.policy.limits;
  const hourAgo = new Date(env.now.getTime() - 3_600_000);
  const dayAgo = new Date(env.now.getTime() - 86_400_000);
  const perHour = await one<{ n: string }>(
    env.ctx.pool,
    `SELECT count(*)::text AS n FROM ceo_actions WHERE org_id=$1 AND mode='decided' AND created_at > $2`,
    [env.orgId, hourAgo],
  );
  if (Number(perHour?.n ?? 0) >= lim.maxActionsPerHour) return `${lim.maxActionsPerHour} actions per hour`;
  if (prepared.subjectId) {
    const per = await one<{ n: string }>(
      env.ctx.pool,
      `SELECT count(*)::text AS n FROM ceo_actions WHERE org_id=$1 AND mode='decided' AND subject_kind=$2 AND subject_id=$3 AND created_at > $4`,
      [env.orgId, prepared.subjectKind, prepared.subjectId, dayAgo],
    );
    if (Number(per?.n ?? 0) >= lim.maxActionsPerSubjectPerDay)
      return `${lim.maxActionsPerSubjectPerDay} actions per subject per day`;
    const undone = await one(
      env.ctx.pool,
      `SELECT 1 FROM ceo_actions WHERE org_id=$1 AND class=$2 AND subject_kind=$3 AND subject_id=$4 AND status='undone' AND undone_at > $5`,
      [env.orgId, cls, prepared.subjectKind, prepared.subjectId, dayAgo],
    );
    if (undone) return 'the owner undid this kind of action on this subject in the last day';
  }
  return undefined;
}

function auditEvent(
  env: ActionEnv,
  origin: CallOrigin,
  def: ActionDef,
  rpc: Pick<ActRpc, 'action' | 'reason' | 'confidence' | 'evidence'> & { params: Record<string, unknown> },
  prepared: Prepared,
  mode: CeoActionMode,
  verdict: PolicyVerdict,
  key: string,
  extra: { result?: Record<string, unknown>; inverse?: CeoInverse | undefined; actionId?: string } = {},
): AppendInput {
  return {
    streamId: streamId.ceo(env.orgId),
    event: {
      type: 'CeoActionTaken',
      payload: {
        actionId: extra.actionId ?? env.actionId,
        orgId: env.orgId,
        class: def.cls,
        action: rpc.action,
        mode,
        subjectKind: prepared.subjectKind,
        subjectId: prepared.subjectId,
        subjectLabel: prepared.subjectLabel,
        params: rpc.params,
        reason: rpc.reason,
        confidence: rpc.confidence,
        evidence: rpc.evidence,
        policyVersion: env.ceo.policyVersion,
        verdictReason: verdict.reason,
        ...(verdict.cause ? { cause: verdict.cause } : {}),
        ...(origin.batchId ? { wakeBatchId: origin.batchId } : {}),
        ...(origin.chatThreadId ? { chatThreadId: origin.chatThreadId } : {}),
        ...(origin.acceptedFrom ? { acceptedFrom: origin.acceptedFrom } : {}),
        ...(origin.order
          ? { order: { entryId: origin.order.entryId, versionHash: origin.order.versionHash } }
          : {}),
        ...(origin.turnId ? { turnId: origin.turnId } : {}),
        origin: { untrusted: origin.untrusted, eventIds: [] },
        ...(extra.inverse ? { inverse: extra.inverse } : {}),
        idemKey: key,
        result: extra.result ?? {},
      },
    },
    actor: agentActor(env.agentId),
    scope: orgScope(env.orgId),
  };
}

export function makeEnv(
  ctx: Ctx,
  ceo: CeoState,
  agent: { id: string; name: string },
  owner: AuthSession['user'],
  origin: CallOrigin,
): ActionEnv {
  return {
    ctx,
    orgId: ceo.orgId,
    ceo,
    agentId: agent.id,
    agentName: agent.name,
    owner,
    actionId: randomUUID(),
    now: ctx.clock.now(),
    evidence: [],
    batchId: origin.batchId,
    chatThreadId: origin.chatThreadId,
    originKind: originKind(origin),
    untrusted: origin.untrusted,
    turnId: origin.turnId,
    acceptedFrom: origin.acceptedFrom,
  };
}

/** Creates the recommendation for an action that was not (or may not be) decided: a desk item the owner can accept. */
async function recommendEvents(
  env: ActionEnv,
  def: ActionDef,
  rpc: ActRpc,
  prepared: Prepared,
  verdict: PolicyVerdict,
  key: string,
  origin: CallOrigin,
): Promise<{ events: AppendInput[]; deskItemId?: string; duplicate?: string }> {
  const open = prepared.subjectId
    ? await one(
        env.ctx.pool,
        `SELECT d.id FROM desk_items d WHERE d.org_id=$1 AND d.subkind='ceo_recommendation' AND d.status='open'
            AND d.data->>'class'=$2 AND d.data->>'subjectId'=$3`,
        [env.orgId, def.cls, prepared.subjectId],
      )
    : undefined;
  if (open) return { events: [], duplicate: open.id };
  const deskItemId = randomUUID();
  const sentence = def.describe(rpc.params, prepared);
  const events: AppendInput[] = [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'approval',
          subkind: 'ceo_recommendation',
          title: `${env.agentName} recommends: ${sentence}`.slice(0, 280),
          body: `${rpc.reason}\n\nConfidence ${Math.round(rpc.confidence * 100)}%. ${verdict.reason}.`,
          options: [
            { id: 'accept', label: 'Do it' },
            { id: 'reject', label: 'Not now' },
          ],
          recommendation: 'accept',
          blocking: false,
          pinned: false,
          affectedCardIds: [],
          askedBy: ceoBy(env),
          data: {
            actionId: env.actionId,
            class: def.cls,
            action: rpc.action,
            params: rpc.params,
            subjectId: prepared.subjectId,
            // An owner turn: the chat shows this as an inline Approve / No card (answered by the Owner's session).
            ...(origin.turnId && originKind(origin) === 'owner' ? { inlineTurnId: origin.turnId } : {}),
          },
        },
      },
      actor: agentActor(env.agentId),
      scope: orgScope(env.orgId),
    },
    {
      streamId: streamId.ceo(env.orgId),
      event: {
        type: 'CeoRecommendationMade',
        payload: {
          actionId: env.actionId,
          orgId: env.orgId,
          class: def.cls,
          deskItemId,
          onExistingItem: false,
          reason: rpc.reason,
          confidence: rpc.confidence,
          action: rpc.action,
          params: rpc.params,
        },
      },
      actor: agentActor(env.agentId),
      scope: orgScope(env.orgId),
    },
  ];
  void key;
  void origin;
  return { events, deskItemId };
}

/**
 * A decision the owner would otherwise have been asked about (a question the CEO answered, a delegated owner-reserved
 * matter, a cancellation, a firing...) goes on the desk as an informational item to acknowledge or correct. Nothing is
 * raised when the owner accepted the recommendation themselves.
 */
async function reviewEvents(
  env: ActionEnv,
  def: ActionDef,
  rpc: ActRpc,
  prepared: Prepared,
  executed: Executed,
  origin: CallOrigin,
): Promise<AppendInput[]> {
  if (origin.acceptedFrom) return [];
  if (!REVIEWED_CLASSES.has(def.cls) && !prepared.reservedKey) return [];
  const ctx = env.ctx;
  let projectId: string | null = null;
  let cardId: string | null = null;
  let question = prepared.subjectLabel;
  let questionItemId: string | undefined;
  if (prepared.subjectKind === 'desk') {
    const it = prepared.data?.item as
      | { id: string; project_id?: string; card_id?: string; title?: string }
      | undefined;
    projectId = it?.project_id ?? null;
    cardId = it?.card_id ?? null;
    question = it?.title ?? question;
    questionItemId = it?.id;
  } else if (prepared.subjectKind === 'card') {
    const c = await one(ctx.pool, 'SELECT id, project_id FROM cards WHERE id=$1', [prepared.subjectId]);
    projectId = c?.project_id ?? null;
    cardId = c?.id ?? null;
  }
  const answer = (executed.result as { answer?: string }).answer;
  return ceoDecisionItemEvents({
    orgId: env.orgId,
    projectId,
    cardId,
    ceoAgentId: env.agentId,
    ceoName: env.agentName,
    cls: def.cls,
    source: 'act',
    actionId: env.actionId,
    question,
    ...(questionItemId ? { questionItemId } : {}),
    decision: answer ?? def.describe(rpc.params, prepared),
    reason: rpc.reason,
    confidence: rpc.confidence,
  });
}

/**
 * The gateway for `aom ceo act` (docs/design/ceo-agent-v2.md section 4.2). Order: idempotency, validation, what the
 * subject is, evidence, limits, the policy verdict, then dry run / refuse / recommend / execute. The action runs inside
 * `withActingAgent`, so its events carry the CEO as actor and the action id as causation; the audit event follows.
 */
export async function runAction(
  env: ActionEnv,
  rpc: ActRpc,
  origin: CallOrigin,
  opts: { force?: boolean; recommendOnly?: boolean } = {},
): Promise<EngineResult> {
  const { ctx } = env;
  const def = ACTIONS[rpc.action as CeoActionName];
  if (!def)
    return {
      status: 'refused',
      message: `the action '${rpc.action}' is not available (yet). Recommend it to the owner instead.`,
    };
  const key = rpc.key ?? defaultKey(origin.scopeId, rpc.action, rpc.params);
  const prior = await one(
    ctx.pool,
    'SELECT id, status, mode, result, desk_item_id FROM ceo_actions WHERE org_id=$1 AND idem_key=$2',
    [env.orgId, key],
  );
  if (prior)
    return {
      status: 'duplicate',
      actionId: prior.id,
      mode: prior.mode,
      ...(prior.desk_item_id ? { deskItemId: prior.desk_item_id } : {}),
      message: `This call was already handled (${prior.status}).`,
      result: prior.result,
    };
  const lockKey = `${env.orgId}|${key}`;
  if (inflight.has(lockKey))
    return { status: 'duplicate', message: 'The same call is being handled right now.' };
  inflight.add(lockKey);
  try {
    const parsed = def.schema.safeParse(rpc.params);
    if (!parsed.success)
      return {
        status: 'refused',
        message: `invalid parameters for ${rpc.action}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'params'} ${i.message}`).join('; ')}`,
      };
    const params = parsed.data as Record<string, unknown>;
    const call = { ...rpc, params };
    env.evidence = rpc.evidence;
    const prepared = await def.prepare(env, params);
    if (prepared.refuse) return { status: 'refused', message: prepared.refuse };
    // A project an Owner or Admin paused is benched: the CEO takes no action on its cards, desk items or the project itself
    // (a recommendation the owner accepts is refused too: resume the project first).
    if (await subjectProjectPaused(ctx.pool, prepared.subjectKind, prepared.subjectId))
      return {
        status: 'refused',
        message: 'this project is paused by an Owner or Admin: take no action on it until it is resumed.',
      };
    const eff: ActionDef = prepared.classOverride ? { ...def, cls: prepared.classOverride } : def;

    const evidence =
      eff.cls === 'desk.answer_question' || prepared.needsEvidence
        ? await evidenceFound(ctx, env.orgId, rpc.evidence)
        : 1;
    const limit = prepared.limitReached ?? (await genericLimit(env, eff.cls, prepared));
    const verdict: PolicyVerdict = opts.force
      ? { verdict: 'allow', reason: 'the owner accepted this recommendation' }
      : opts.recommendOnly
        ? { verdict: 'recommend', reason: 'raised by the CEO as a recommendation', cause: 'mode' }
        : evaluatePolicy(env.ceo.policy, eff.cls, {
            origin: {
              kind: originKind(origin),
              ...(origin.order ? { covers: origin.order.covers } : {}),
            },
            confidence: rpc.confidence,
            // An order the wake's scope pre-filter already bounds is not "triggered by outside text".
            untrustedOrigin: origin.untrusted && !prepared.trustedByScope,
            reservedKey: prepared.reservedKey ?? null,
            evidenceMissing: !!prepared.needsEvidence && evidence === 0,
            deskMode: prepared.deskMode,
            limitReached: limit,
          });
    const wouldBe: CeoActionMode =
      verdict.verdict === 'allow' ? 'decided' : verdict.verdict === 'recommend' ? 'recommended' : 'refused';
    if (rpc.dryRun)
      return {
        status: 'dry_run',
        wouldBe,
        message: `Dry run: this would be ${wouldBe}. ${verdict.reason}. Effect: ${def.describe(params, prepared)}`,
      };

    if (verdict.verdict === 'deny') {
      await ctx.store.append([auditEvent(env, origin, eff, call, prepared, 'refused', verdict, key)]);
      return {
        status: 'refused',
        mode: 'refused',
        actionId: env.actionId,
        message: `Refused: ${verdict.reason}.`,
      };
    }

    if (verdict.verdict === 'recommend') {
      const rec = await recommendEvents(env, eff, call, prepared, verdict, key, origin);
      const inline = verdict.inline === true && !!origin.turnId;
      if (rec.duplicate)
        return {
          status: 'recommended',
          deskItemId: rec.duplicate,
          message: 'The owner already has a recommendation for this on the desk.',
        };
      await ctx.store.append([
        auditEvent(env, origin, eff, call, prepared, 'recommended', verdict, key),
        ...rec.events,
      ]);
      return {
        status: 'recommended',
        mode: 'recommended',
        actionId: env.actionId,
        ...(rec.deskItemId ? { deskItemId: rec.deskItemId } : {}),
        message: inline
          ? `Needs the owner's confirmation: ${verdict.reason}. The chat shows him an Approve / No card; tell him what you are asking and wait for his answer. Do not retry it another way.`
          : `Recommended to the owner instead of done: ${verdict.reason}. This is a normal result; do not retry it another way.`,
      };
    }

    // allow: execute with the CEO as the actor, then audit.
    const executed = await withActingAgent({ agentId: env.agentId, actionId: env.actionId }, () =>
      def.execute(env, params, prepared),
    );
    await ctx.store.append([
      auditEvent(env, origin, eff, call, prepared, 'decided', verdict, key, {
        result: executed.result,
        inverse: executed.inverse,
      }),
      ...(await reviewEvents(env, eff, call, prepared, executed, origin)),
    ]);
    return {
      status: 'executed',
      mode: 'decided',
      actionId: env.actionId,
      message: executed.message,
      result: executed.result,
    };
  } catch (err) {
    if (err instanceof HttpError) return { status: 'refused', message: err.message };
    throw err;
  } finally {
    inflight.delete(lockKey);
  }
}

/** `aom ceo recommend --item`: advice put on an existing desk item (no decision, no policy needed). */
export async function recommendOnItem(
  env: ActionEnv,
  rpc: Extract<CeoRpc, { op: 'recommend' }>,
  origin: CallOrigin,
): Promise<EngineResult> {
  const { ctx } = env;
  const item = await one(ctx.pool, `SELECT d.* FROM desk_items d WHERE d.id=$1 AND d.org_id=$2`, [
    rpc.item,
    env.orgId,
  ]);
  if (!item) return { status: 'refused', message: 'that desk item does not exist' };
  if (item.status !== 'open') return { status: 'refused', message: `this item is already ${item.status}` };
  if (rpc.option && !(item.options as Array<{ id: string }>).some((o) => o.id === rpc.option))
    return { status: 'refused', message: `option ${rpc.option} is not one of the item's options` };
  if (!rpc.option && !rpc.text) return { status: 'refused', message: 'give --option or --text' };
  const key =
    rpc.key ??
    defaultKey(origin.scopeId, 'recommend', { item: rpc.item, option: rpc.option, text: rpc.text });
  const prior = await one(ctx.pool, 'SELECT id FROM ceo_actions WHERE org_id=$1 AND idem_key=$2', [
    env.orgId,
    key,
  ]);
  if (prior)
    return { status: 'duplicate', actionId: prior.id, message: 'This recommendation was already made.' };
  const cls = item.kind === 'question' || item.kind === 'escalation' ? 'desk.answer_question' : 'desk.triage';
  const events: AppendInput[] = [];
  if (item.triage === 'pending')
    events.push({
      streamId: streamId.desk(item.id),
      event: {
        type: 'DeskItemTriaged',
        payload: {
          deskItemId: item.id,
          outcome: 'passed',
          note: `${env.agentName} recommends an answer`,
          by: ceoBy(env),
        },
      },
      actor: agentActor(env.agentId),
      scope: item.project_id
        ? { orgId: env.orgId, projectId: item.project_id, audience: 'project' }
        : orgScope(env.orgId),
    });
  const label = String(item.title).replace(/\s+/g, ' ').slice(0, 120);
  events.push(
    {
      streamId: streamId.ceo(env.orgId),
      event: {
        type: 'CeoActionTaken',
        payload: {
          actionId: env.actionId,
          orgId: env.orgId,
          class: cls,
          action: 'recommend',
          mode: 'recommended',
          subjectKind: 'desk',
          subjectId: item.id,
          subjectLabel: label,
          params: { option: rpc.option ?? null, text: rpc.text ?? null },
          reason: rpc.reason,
          confidence: rpc.confidence,
          evidence: rpc.evidence,
          policyVersion: env.ceo.policyVersion,
          verdictReason: 'advice on an item the owner decides',
          ...(origin.batchId ? { wakeBatchId: origin.batchId } : {}),
          ...(origin.chatThreadId ? { chatThreadId: origin.chatThreadId } : {}),
          origin: { untrusted: origin.untrusted, eventIds: [] },
          idemKey: key,
          result: {},
        },
      },
      actor: agentActor(env.agentId),
      scope: orgScope(env.orgId),
    },
    {
      streamId: streamId.ceo(env.orgId),
      event: {
        type: 'CeoRecommendationMade',
        payload: {
          actionId: env.actionId,
          orgId: env.orgId,
          class: cls,
          deskItemId: item.id,
          onExistingItem: true,
          ...(rpc.option ? { option: rpc.option } : {}),
          ...(rpc.text ? { text: rpc.text } : {}),
          reason: rpc.reason,
          confidence: rpc.confidence,
        },
      },
      actor: agentActor(env.agentId),
      scope: orgScope(env.orgId),
    },
  );
  await ctx.store.append(events);
  return {
    status: 'recommended',
    mode: 'recommended',
    actionId: env.actionId,
    deskItemId: item.id,
    message: 'Your recommendation is on the item; the owner decides.',
  };
}
