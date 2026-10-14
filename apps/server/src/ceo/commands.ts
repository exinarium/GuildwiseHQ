import { randomUUID } from 'node:crypto';
import {
  type AgentChanges,
  agreementScores,
  CEO_ROLE_KEY,
  type CeoPolicy,
  CeoPolicySchema,
  type CeoSettings,
  CeoSettingsSchema,
  type CeoTraining,
  clonePolicy,
  DEFAULT_AVATAR_STYLE,
  DEFAULT_CEO_POLICY,
  DEFAULT_CEO_SETTINGS,
  extendTraining,
  graduate,
  isOrgManager,
  type RecommendationResponse,
  randomAvatarSeed,
  startTraining,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadRole } from '../catalogue/loader.ts';
import { agentScope, sandboxGate, suggestNames } from '../commands/agents.ts';
import { cardMessage, orgScope, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { assertWithinLimit } from '../orgs/limits.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { ownerPrincipal } from './engine.ts';
import { loadCeo } from './state.ts';

export const isOrgOwner = async (db: Tx | Ctx['pool'], userId: string, orgId: string): Promise<boolean> =>
  (await orgRoleOf(db, userId, orgId)) === 'owner';

async function requireOwner(db: Ctx['pool'] | Tx, userId: string, orgId: string): Promise<void> {
  if (!(await isOrgOwner(db, userId, orgId))) throw forbidden('only the organization Owner can do this');
}

/** Hires the organization's CEO: the agent, its settings, the default policy and the training period, in one append. */
export async function appointCeo(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string },
  req: { workstationId: string; name?: string | undefined; acknowledgeUnsandboxed?: boolean | undefined },
): Promise<string> {
  const agentId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    await requireOwner(tx, user.id, org.id);
    if (
      await one(tx, `SELECT 1 FROM agents WHERE org_id=$1 AND role_key=$2 AND status <> 'retired'`, [
        org.id,
        CEO_ROLE_KEY,
      ])
    )
      throw conflict('ceo_exists', 'this organization already has a CEO');
    const ws = await one(
      tx,
      `SELECT id FROM workstations WHERE id=$1 AND status='active' AND (user_id=$2 OR simulation_org_id=$3)`,
      [req.workstationId, user.id, org.id],
    );
    if (!ws) throw notFound('workstation not found: the CEO runs on your own workstation');
    const role = await loadRole(tx, org.id, CEO_ROLE_KEY);
    if (!role) throw badRequest('unknown_role', 'the CEO role is not available');
    const uses = await one(
      tx,
      `SELECT 1 FROM agents WHERE org_id=$1 AND workstation_id=$2 AND status='active' AND NOT is_devops LIMIT 1`,
      [org.id, req.workstationId],
    );
    if (!uses) await assertWithinLimit(tx, org.id, 'workstations');
    const dm = role.definition.defaultModel;
    const unsandboxedAck = await sandboxGate(
      ctx,
      tx,
      user.id,
      req.workstationId,
      dm.runtime,
      req.acknowledgeUnsandboxed,
    );
    const name = req.name?.trim() || (await suggestNames(ctx, org.id, undefined, 1))[0] || 'Chief';
    if (await one(tx, 'SELECT 1 FROM agents WHERE org_id=$1 AND lower(name)=lower($2)', [org.id, name]))
      throw conflict('name_taken', `the name '${name}' is already used in this organization`);
    const now = ctx.clock.now();
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: {
            type: 'AgentHired',
            payload: {
              agentId,
              orgId: org.id,
              allowedProjectIds: null,
              hiredByUserId: user.id,
              workstationId: req.workstationId,
              name,
              roleKey: role.key,
              roleVersion: role.version,
              seniority: 'senior',
              runtime: dm.runtime,
              model: dm.model,
              effort: dm.effort,
              skills: role.definition.skills,
              permissions: role.definition.permissions,
              capacity: 1,
              isDevops: false,
              avatarSeed: randomAvatarSeed(),
              avatarStyle: DEFAULT_AVATAR_STYLE,
              ...(unsandboxedAck ? { unsandboxedAck } : {}),
            },
          },
          actor: userActor(user.id),
          scope: orgScope(org.id),
        },
        {
          streamId: streamId.ceo(org.id),
          event: {
            type: 'CeoEnabled',
            payload: {
              orgId: org.id,
              agentId,
              by: user.id,
              policy: DEFAULT_CEO_POLICY,
              settings: DEFAULT_CEO_SETTINGS,
              training: startTraining(now),
            },
          },
          actor: userActor(user.id),
          scope: orgScope(org.id),
        },
      ],
      { tx },
    );
  });
  ctx.services.dispatcher.trigger();
  return agentId;
}

/** Disables the CEO: the agent is retired (history stays), wakes are dropped, the BA reports again. */
export async function disableCeo(ctx: Ctx, user: AuthSession['user'], orgId: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    await requireOwner(tx, user.id, orgId);
    const ceo = await loadCeo(tx, orgId);
    if (!ceo?.enabled || !ceo.agentId) throw conflict('no_ceo', 'there is no CEO to disable');
    const a = await one(tx, 'SELECT * FROM agents WHERE id=$1', [ceo.agentId]);
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(ceo.agentId),
          event: {
            type: 'AgentRetired',
            payload: { agentId: ceo.agentId, by: user.id, releasedCardIds: [] },
          },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
        {
          streamId: streamId.ceo(orgId),
          event: { type: 'CeoDisabled', payload: { orgId, agentId: ceo.agentId, by: user.id } },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    await exec(
      tx,
      `UPDATE ceo_wakes SET status='dropped' WHERE org_id=$1 AND status IN ('pending','taken')`,
      [orgId],
    );
    if (a?.workstation_id)
      await enqueueRunnerCommand(tx, a.workstation_id, 'agent.wipe', { agentId: ceo.agentId });
    if (a?.workstation_id) {
      // a running CEO shift stops
      const open = await rows(
        tx,
        `SELECT id, workstation_id FROM shifts WHERE agent_id=$1 AND status <> 'ended'`,
        [ceo.agentId],
      );
      for (const s of open) ctx.services.gateway.stopShift(s.workstation_id, s.id, 'agent_retired');
    }
  });
}

export async function pauseCeo(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  reason?: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const role = await orgRoleOf(tx, user.id, orgId);
    if (!isOrgManager({ orgRole: role })) throw forbidden('only the Owner and Admins can pause the CEO');
    const ceo = await loadCeo(tx, orgId);
    if (!ceo?.enabled) throw conflict('no_ceo', 'there is no CEO');
    if (ceo.paused) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.ceo(orgId),
          event: { type: 'CeoPaused', payload: { orgId, by: user.id, ...(reason ? { reason } : {}) } },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
}

export async function resumeCeo(ctx: Ctx, user: AuthSession['user'], orgId: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const role = await orgRoleOf(tx, user.id, orgId);
    if (!isOrgManager({ orgRole: role })) throw forbidden('only the Owner and Admins can resume the CEO');
    const ceo = await loadCeo(tx, orgId);
    if (!ceo?.enabled) throw conflict('no_ceo', 'there is no CEO');
    if (!ceo.paused) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.ceo(orgId),
          event: { type: 'CeoResumed', payload: { orgId, by: user.id } },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
  ctx.services.dispatcher.trigger();
}

export async function updateCeoSettings(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  patch: Partial<CeoSettings>,
): Promise<CeoSettings> {
  return withAppendTx(ctx.pool, async (tx) => {
    await requireOwner(tx, user.id, orgId);
    const ceo = await loadCeo(tx, orgId);
    if (!ceo?.enabled) throw conflict('no_ceo', 'there is no CEO');
    const merged = CeoSettingsSchema.parse({
      ...ceo.settings,
      ...patch,
      persona: { ...ceo.settings.persona, ...(patch.persona ?? {}) },
      models: { ...ceo.settings.models, ...(patch.models ?? {}) },
      notify: { ...ceo.settings.notify, ...(patch.notify ?? {}) },
    });
    await ctx.store.append(
      [
        {
          streamId: streamId.ceo(orgId),
          event: { type: 'CeoSettingsChanged', payload: { orgId, settings: merged, by: user.id } },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    return merged;
  });
}

const POLICY_DELEGATION_RISK =
  'Delegating an owner-reserved matter lets the CEO decide it without asking you.';

/** The owner saves the policy: a new version, validated; delegations need the explicit confirmation. */
export async function updateCeoPolicy(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  policy: unknown,
  opts: { confirmDelegation?: boolean; note?: string } = {},
): Promise<CeoPolicy> {
  return withAppendTx(ctx.pool, async (tx) => {
    await requireOwner(tx, user.id, orgId);
    const ceo = await loadCeo(tx, orgId);
    if (!ceo?.enabled) throw conflict('no_ceo', 'there is no CEO');
    const parsed = CeoPolicySchema.safeParse(policy);
    if (!parsed.success)
      throw badRequest(
        'invalid_policy',
        parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
      );
    const next = { ...parsed.data, version: ceo.policyVersion + 1 };
    const added = next.delegated.filter((k) => !ceo.policy.delegated.includes(k));
    if (added.length && !opts.confirmDelegation)
      throw conflict(
        'delegation_unconfirmed',
        `${POLICY_DELEGATION_RISK} Confirm to delegate: ${added.join(', ')}.`,
      );
    await ctx.store.append(
      [
        {
          streamId: streamId.ceo(orgId),
          event: {
            type: 'CeoPolicyChanged',
            payload: {
              orgId,
              version: next.version,
              previousVersion: ceo.policyVersion,
              policy: next,
              by: user.id,
              ...(opts.note ? { note: opts.note } : {}),
            },
          },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    return next;
  });
}

export async function resetCeoPolicy(ctx: Ctx, user: AuthSession['user'], orgId: string): Promise<CeoPolicy> {
  return updateCeoPolicy(ctx, user, orgId, clonePolicy(DEFAULT_CEO_POLICY), { note: 'reset to defaults' });
}

/** Agreement scores of the training observations (class, agreed, total). */
export async function trainingScores(db: Ctx['pool'] | Tx, orgId: string) {
  const r = await rows<{ class: string; response: RecommendationResponse }>(
    db,
    `SELECT class, response FROM ceo_actions WHERE org_id=$1 AND mode='recommended' AND response IS NOT NULL`,
    [orgId],
  );
  return agreementScores(r);
}

/** Graduate, extend or restart the training period (owner only). */
export async function changeTraining(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  action: 'graduate' | 'extend' | 'restart',
): Promise<CeoTraining> {
  return withAppendTx(ctx.pool, async (tx) => {
    await requireOwner(tx, user.id, orgId);
    const ceo = await loadCeo(tx, orgId);
    if (!ceo?.enabled) throw conflict('no_ceo', 'there is no CEO');
    const now = ctx.clock.now();
    const t =
      action === 'graduate'
        ? graduate(ceo.training, now)
        : action === 'extend'
          ? extendTraining(ceo.training, now)
          : startTraining(now, ceo.training.extensions + 1);
    const scores = await trainingScores(tx, orgId);
    await ctx.store.append(
      [
        {
          streamId: streamId.ceo(orgId),
          event: { type: 'CeoTrainingChanged', payload: { orgId, action, training: t, by: user.id, scores } },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    return t;
  });
}

// ------------------------------------------------------------------------------------------------- undo

async function pre(
  tx: Tx | Ctx['pool'],
  orgId: string,
  name: string,
  pc: Record<string, unknown>,
  params: Record<string, any>,
): Promise<string | undefined> {
  if (name === 'resume-agent' || name === 'pause-agent') {
    const a = await one(tx, 'SELECT paused_at, status FROM agents WHERE id=$1 AND org_id=$2', [
      params.agent,
      orgId,
    ]);
    if (!a || a.status === 'retired') return 'the agent is gone';
    if ((pc.paused === true) !== !!a.paused_at)
      return pc.paused ? 'the agent is no longer paused' : 'the agent has been paused since';
  }
  if (name === 'priority') {
    const c = await one(tx, 'SELECT priority FROM cards WHERE id=$1 AND org_id=$2', [params.card, orgId]);
    if (!c) return 'the card is gone';
    if (c.priority !== pc.priority) return `the priority was changed again (it is ${c.priority} now)`;
  }
  if (name === 'model' || name === 'seniority') {
    const a = await one(tx, 'SELECT model, seniority, status FROM agents WHERE id=$1 AND org_id=$2', [
      params.agent,
      orgId,
    ]);
    if (!a || a.status === 'retired') return 'the agent is gone';
    if (pc.model !== undefined && a.model !== pc.model)
      return `the model was changed again (it is ${a.model} now)`;
    if (pc.seniority !== undefined && a.seniority !== pc.seniority)
      return `the seniority was changed again (it is ${a.seniority} now)`;
  }
  if (name === 'unhire') {
    const a = await one(tx, 'SELECT status FROM agents WHERE id=$1 AND org_id=$2', [params.agent, orgId]);
    if (!a || a.status === 'retired') return 'the agent is gone already';
  }
  if (name === 'reopen-card') {
    const c = await one(tx, 'SELECT status FROM cards WHERE id=$1 AND org_id=$2', [params.card, orgId]);
    if (c?.status !== 'cancelled') return 'the card is not cancelled any more';
  }
  if (name === 'cancel-draft') {
    const c = await one(tx, 'SELECT status, claim_id FROM cards WHERE id=$1 AND org_id=$2', [
      params.card,
      orgId,
    ]);
    if (!c || ['done', 'cancelled'].includes(c.status)) return 'the card is closed already';
    if (c.claim_id) return 'an agent has started on the card';
  }
  if (name === 'dismiss-item') {
    const d = await one(tx, 'SELECT status FROM desk_items WHERE id=$1 AND org_id=$2', [params.item, orgId]);
    if (d?.status !== 'open') return 'the owner already decided it';
  }
  return undefined;
}

export interface UndoResult {
  kind: 'inverse' | 'compensating';
  message: string;
}

/** Inverses that run through the ordinary commands (each in its own transaction); the audit follows. */
async function runInverse(
  ctx: Ctx,
  user: AuthSession['user'],
  inv: { action: string; params: Record<string, any> },
): Promise<string> {
  const { cancelCard, dismissInto, patchCard, reopenCard } = await import('./undo-commands.ts');
  const { fireAgent, patchAgent, setAgentAllowedProjects } = await import('../commands/agents.ts');
  const p = inv.params;
  const unhire = async (agentId: string) => {
    const worked = await one(
      ctx.pool,
      `SELECT 1 FROM shifts WHERE agent_id=$1 AND status='ended' AND kind <> 'chat' LIMIT 1`,
      [agentId],
    );
    if (worked) {
      await setAgentAllowedProjects(ctx, user, agentId, []);
      return 'benched (it had already worked)';
    }
    await fireAgent(ctx, user, agentId);
    return 'retired (it had not worked yet)';
  };
  switch (inv.action) {
    case 'priority':
      await patchCard(ctx, user, p.card, { priority: p.to });
      return 'The priority is back.';
    case 'model':
      await patchAgent(ctx, user, p.agent, { model: p.to, ...(p.effort ? { effort: p.effort } : {}) });
      return 'The model is back.';
    case 'seniority':
      await patchAgent(ctx, user, p.agent, { seniority: p.to });
      return 'The seniority is back.';
    case 'allow-restore':
      await setAgentAllowedProjects(ctx, user, p.agent, p.projectIds);
      return 'The agent works where it did before.';
    case 'unhire':
      return `The hire was ${await unhire(p.agent)}.`;
    case 'scale-undo': {
      for (const id of (p.hired ?? []) as string[]) await unhire(id);
      for (const r of (p.reduced ?? []) as Array<{ agent: string; prev: string[] | null }>)
        await setAgentAllowedProjects(ctx, user, r.agent, r.prev);
      return 'The team is as it was.';
    }
    case 'reopen-card':
      await reopenCard(ctx, user, p.card, p.stage, 'undo of the CEO cancelling this card');
      return 'The card is open again.';
    case 'cancel-draft':
      await cancelCard(ctx, user, p.card, 'undo of the CEO request');
      return 'The draft is cancelled.';
    case 'dismiss-item':
      await dismissInto(ctx, user, p.item);
      return 'The proposal is withdrawn.';
    default:
      throw conflict('not_reversible', `no undo for ${inv.action}`);
  }
}

const OUTSIDE_TX = new Set([
  'priority',
  'model',
  'seniority',
  'allow-restore',
  'unhire',
  'scale-undo',
  'reopen-card',
  'cancel-draft',
  'dismiss-item',
]);

/**
 * Undo (docs/design/ceo-agent-v2.md section 3.5): checks that the precondition still holds, runs the stored inverse as the
 * Owner, appends `CeoActionUndone`. A desk answer is compensating: it re-opens the question when no card it released has
 * been taken since; otherwise the answer stays and a correction goes on the card and the owner's desk.
 */
export async function undoCeoAction(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  actionId: string,
): Promise<UndoResult> {
  const a = await one(ctx.pool, 'SELECT * FROM ceo_actions WHERE id=$1 AND org_id=$2', [actionId, orgId]);
  if (!a) throw notFound('action not found');
  await requireOwner(ctx.pool, user.id, orgId);
  if (a.status === 'undone') throw conflict('already_undone', 'this action was already undone');
  if (a.status !== 'done' || !a.inverse)
    throw conflict(
      'not_reversible',
      'this action cannot be undone (it is not reversible, or it was only a recommendation)',
    );
  const inv = a.inverse as {
    kind: 'inverse' | 'compensating';
    action: string;
    params: Record<string, any>;
    preconditions: Record<string, unknown>;
    label: string;
  };
  let kind: 'inverse' | 'compensating' = inv.kind;
  let message = inv.label || 'Undone.';
  const audit = (): AppendInput => ({
    streamId: streamId.ceo(orgId),
    event: { type: 'CeoActionUndone', payload: { actionId, orgId, by: user.id, kind } },
    actor: userActor(user.id),
    scope: orgScope(orgId),
  });
  if (OUTSIDE_TX.has(inv.action)) {
    const why = await pre(ctx.pool, orgId, inv.action, inv.preconditions, inv.params);
    if (why) throw conflict('stale', `cannot undo: ${why}`);
    message = await runInverse(ctx, user, inv);
    await withAppendTx(ctx.pool, async (tx) => {
      const cur = await one(tx, 'SELECT status FROM ceo_actions WHERE id=$1 FOR UPDATE', [actionId]);
      if (cur?.status === 'done') await ctx.store.append([audit()], { tx });
    });
  } else {
    await withAppendTx(ctx.pool, async (tx) => {
      const cur = await one(tx, 'SELECT status FROM ceo_actions WHERE id=$1 FOR UPDATE', [actionId]);
      if (cur?.status !== 'done') throw conflict('already_undone', 'this action was already undone');
      const why = await pre(tx, orgId, inv.action, inv.preconditions, inv.params);
      if (why) throw conflict('stale', `cannot undo: ${why}`);
      const events: AppendInput[] = [];
      if (inv.action === 'resume-agent' || inv.action === 'pause-agent') {
        const ag = await one(tx, 'SELECT * FROM agents WHERE id=$1', [inv.params.agent]);
        events.push({
          streamId: streamId.agent(inv.params.agent),
          event:
            inv.action === 'resume-agent'
              ? {
                  type: 'AgentResumed' as const,
                  payload: { agentId: inv.params.agent, by: user.id, viaCeo: false },
                }
              : {
                  type: 'AgentPaused' as const,
                  payload: { agentId: inv.params.agent, by: user.id, reason: 'undo', viaCeo: false },
                },
          actor: userActor(user.id),
          scope: agentScope(ag ?? { org_id: orgId }),
        });
      } else if (inv.action === 'reopen-question') {
        const item = await one(tx, 'SELECT * FROM desk_items WHERE id=$1', [inv.params.item]);
        if (!item || item.status !== 'answered')
          throw conflict('stale', 'cannot undo: the question is not answered any more');
        const cardIds: string[] = inv.params.unblocked ?? [];
        const cards = cardIds.length
          ? await rows(tx, 'SELECT * FROM cards WHERE id = ANY($1::uuid[])', [cardIds])
          : [];
        const untouched = cards.every((c) => c.status === 'queued' && !c.claim_id);
        if (untouched) {
          events.push({
            streamId: streamId.desk(item.id),
            event: {
              type: 'QuestionReopened' as const,
              payload: {
                deskItemId: item.id,
                by: { kind: 'user' as const, id: user.id },
                note: 'The owner undid the CEO answer.',
                blockedCardIds: cardIds,
              },
            },
            actor: userActor(user.id),
            scope: item.project_id
              ? { orgId, projectId: item.project_id, audience: 'project' as const }
              : orgScope(orgId),
          });
          message = 'The question is open again on your desk; the cards wait for your answer.';
        } else {
          kind = 'compensating';
          for (const c of cards)
            events.push(
              cardMessage(
                c,
                { kind: 'system' },
                'system',
                `The owner undid the CEO's answer to "${String(item.title).slice(0, 120)}": do not rely on it. Ask the owner if it matters for your work.`,
              ),
            );
          const noticeId = randomUUID();
          events.push({
            streamId: streamId.desk(noticeId),
            event: {
              type: 'DeskItemCreated' as const,
              payload: {
                deskItemId: noticeId,
                kind: 'alert' as const,
                subkind: 'ceo_notice',
                title: 'You undid a CEO answer, but work had already started',
                body: `Question: ${item.title}\n\nThe CEO answered: ${item.answer}\n\nA correction was posted on the cards. Tell the agents what you want instead.`,
                options: [],
                blocking: false,
                pinned: false,
                affectedCardIds: cardIds,
                askedBy: { kind: 'system' as const },
              },
            },
            actor: { kind: 'system' as const, id: null },
            scope: orgScope(orgId),
          });
          message = 'Work had already started: a correction was posted on the cards and on your desk.';
        }
      } else throw conflict('not_reversible', `no undo for ${inv.action}`);
      events.push(audit());
      await ctx.store.append(events, { tx });
    });
  }
  ctx.services.dispatcher.trigger();
  const { onUndo } = await import('./learning.ts');
  await onUndo(ctx, orgId, user.id, a as Row).catch((err) =>
    ctx.log.error({ err }, 'ceo undo learning failed'),
  );
  return { kind, message };
}

export type { AgentChanges };
