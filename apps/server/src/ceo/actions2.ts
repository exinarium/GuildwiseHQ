import { randomUUID } from 'node:crypto';
import {
  type ActionClass,
  type CeoActionName,
  type CeoInverse,
  effortBelowRoleMinimum,
  modelTier,
  streamId,
} from '@aom/shared';
import { z } from 'zod';
import { loadRole } from '../catalogue/loader.ts';
import {
  fireAgent,
  hireAgent,
  patchAgent,
  setAgentAllowedProjects,
  suggestNames,
} from '../commands/agents.ts';
import { cancelCard, specifyCardIn } from '../commands/cards.ts';
import { cardMessage, orgScope, userActor } from '../commands/common.ts';
import { isNearDuplicate } from '../commands/ledger-checks.ts';
import { retireLedgerEntryAs } from '../commands/ledger-retire.ts';
import {
  cardMissing,
  hasActiveBa,
  missingText,
  queueSpecCardTask,
  splitMissing,
} from '../commands/spec-card.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { landedSql } from '../dispatcher/dependencies.ts';
import { conflict } from '../errors.ts';
import { applyRecommendation, listRecommendations } from '../hr/hr.ts';
import { agentByName, appendLocked, cardOf, ceoBy, deskItem, refuse, truncate } from './actions.ts';
import { budgetBlock, hireEvidenceMissing } from './staffing.ts';
import type { ActionDef, ActionEnv, Executed, Prepared } from './types.ts';

const who = (env: ActionEnv) => ({ userId: env.owner.id, orgId: env.orgId, role: 'owner' as const });

async function projectsByKey(db: Queryable, orgId: string, keys: string[]): Promise<Row[] | string> {
  const found = await rows(
    db,
    `SELECT id, key FROM projects WHERE org_id=$1 AND kind='project' AND status='active' AND key = ANY($2::text[])`,
    [orgId, keys.map((k) => k.toUpperCase())],
  );
  const missing = keys.filter((k) => !found.some((p) => p.key === k.toUpperCase()));
  return missing.length ? `unknown project ${missing.join(', ')}` : found;
}

const csv = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean));

// ------------------------------------------------------------------------------------------- reassign

const ReassignP = z.object({ card: z.string().min(1).max(40), agent: z.string().min(1).max(120) });
const reassign: ActionDef<z.infer<typeof ReassignP>> = {
  cls: 'card.reassign',
  schema: ReassignP,
  describe: (p, pr) => `Give ${pr.subjectLabel} to ${p.agent}`,
  async prepare(env, p) {
    const card = await cardOf(env.ctx.pool, env, p.card);
    if (!card) return refuse(`card ${p.card} not found`);
    const base = {
      subjectKind: 'card',
      subjectId: card.id as string,
      subjectLabel: `${card.ref} ${truncate(card.title, 80)}`,
    };
    const a = await agentByName(env.ctx.pool, env.orgId, p.agent);
    if (!a || a.status !== 'active' || a.is_devops || a.role_key === 'ceo')
      return { ...base, refuse: `${p.agent} cannot take cards` };
    if (a.paused_at) return { ...base, refuse: `${a.name} is paused` };
    if (['done', 'cancelled', 'draft'].includes(card.status))
      return { ...base, refuse: `the card is ${card.status}` };
    if (card.status === 'held') {
      const open = await rows(
        env.ctx.pool,
        `SELECT dc.ref FROM card_dependencies d JOIN cards dc ON dc.id = d.depends_on_card_id
          WHERE d.card_id=$1 AND NOT ${landedSql('dc')} ORDER BY dc.number`,
        [card.id],
      );
      return {
        ...base,
        refuse: `the design of ${card.ref} is ready and held on purpose until ${open.map((r) => r.ref).join(', ') || 'its dependencies'} landed; it returns to the queue by itself, nobody can take it before`,
      };
    }
    if (card.claimed_by_agent_id === a.id) return { ...base, refuse: `${a.name} has the card already` };
    return { ...base, targetAgentId: a.id, data: { card, agent: a } };
  },
  async execute(env, _p, pr) {
    const card = pr.data?.card as Row;
    const a = pr.data?.agent as Row;
    if (card.claim_id) {
      const { releaseCard } = await import('../commands/cards.ts');
      await releaseCard(env.ctx, env.owner, card.id, `reassigned to ${a.name} by the CEO`);
    }
    env.ctx.services.dispatcher.prefer(card.id, a.id);
    await appendLocked(env, [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardReassigned',
          payload: {
            cardId: card.id,
            ...(card.claimed_by_agent_id ? { fromAgentId: card.claimed_by_agent_id } : {}),
            toAgentId: a.id,
            by: env.owner.id,
            viaCeo: true,
          },
        },
        actor: userActor(env.owner.id),
        scope: { orgId: env.orgId, projectId: card.project_id, audience: 'project' },
      },
      cardMessage(card, { kind: 'agent', agentId: env.agentId }, 'comment', `Reassigned to ${a.name}.`, {
        viaCeo: true,
      }),
    ]);
    env.ctx.services.dispatcher.trigger();
    return { message: `${card.ref} goes to ${a.name} next.`, result: { cardId: card.id, to: a.id } };
  },
};

// ----------------------------------------------------------------------------------------- cancel card

const CancelP = z.object({
  card: z.string().min(1).max(40),
  note: z.string().trim().min(3).max(1000).optional(),
});
const cancelCardAction: ActionDef<z.infer<typeof CancelP>> = {
  cls: 'card.cancel',
  schema: CancelP,
  describe: (p, pr) => `Cancel ${pr.subjectLabel}${p.note ? ` (${p.note})` : ''}`,
  async prepare(env, p) {
    const card = await cardOf(env.ctx.pool, env, p.card);
    if (!card) return refuse(`card ${p.card} not found`);
    const base = {
      subjectKind: 'card',
      subjectId: card.id as string,
      subjectLabel: `${card.ref} ${truncate(card.title, 80)}`,
    };
    if (['done', 'cancelled'].includes(card.status))
      return { ...base, refuse: `the card is already ${card.status}` };
    const n = await one<{ n: string }>(
      env.ctx.pool,
      `SELECT count(*)::text AS n FROM ceo_actions WHERE org_id=$1 AND class='card.cancel' AND mode='decided' AND created_at > $2`,
      [env.orgId, new Date(env.now.getTime() - 3_600_000)],
    );
    return { ...base, reservedKey: Number(n?.n ?? 0) >= 3 ? 'mass_cancel' : null, data: { card } };
  },
  async execute(env, p, pr) {
    const card = pr.data?.card as Row;
    await cancelCard(env.ctx, env.owner, card.id, p.note ?? 'cancelled by the CEO');
    return {
      message: `${card.ref} is cancelled.`,
      result: { cardId: card.id },
      inverse: {
        kind: 'inverse',
        action: 'reopen-card',
        params: { card: card.id, stage: card.stage },
        preconditions: { status: 'cancelled' },
        label: `Reopen ${card.ref}`,
      },
    };
  },
};

// ---------------------------------------------------------------------------------- model, seniority

const ModelP = z.object({
  agent: z.string().min(1),
  to: z.string().min(1).max(100),
  effort: z.string().max(20).optional(),
});
const modelAction: ActionDef<z.infer<typeof ModelP>> = {
  cls: 'agent.change_model',
  schema: ModelP,
  describe: (p, pr) => `Move ${pr.subjectLabel} to ${p.to}${p.effort ? ` (${p.effort})` : ''}`,
  async prepare(env, p) {
    const a = await agentByName(env.ctx.pool, env.orgId, p.agent);
    if (!a) return refuse(`agent ${p.agent} not found`);
    const base = {
      subjectKind: 'agent',
      subjectId: a.id as string,
      subjectLabel: `${a.name} (${a.role_key})`,
      targetAgentId: a.id as string,
    };
    if (a.status !== 'active' || a.is_devops || a.role_key === 'ceo')
      return { ...base, refuse: `${a.name}'s model is not changed this way` };
    if (a.model === p.to && (!p.effort || a.effort === p.effort))
      return { ...base, refuse: `${a.name} already runs ${p.to}` };
    const from = modelTier(a.model);
    const to = modelTier(p.to);
    if (to === null) return { ...base, refuse: `${p.to} is not a model on the ladder (haiku, sonnet, opus)` };
    // One tier per week per agent.
    const recent = await one(
      env.ctx.pool,
      `SELECT 1 FROM ceo_actions WHERE org_id=$1 AND class='agent.change_model' AND mode='decided' AND status='done' AND subject_id=$2 AND created_at > $3`,
      [env.orgId, a.id, new Date(env.now.getTime() - 7 * 86_400_000)],
    );
    // Reviewers stay on high effort (backlog #70): lowering their effort or model is a recommendation for the owner.
    if (
      a.role_key === 'reviewer' &&
      (effortBelowRoleMinimum('reviewer', p.effort) || (from !== null && to < from))
    )
      return {
        ...base,
        refuse: `${a.name} is a reviewer: reviewers stay on high effort and their model is not lowered automatically. Raise it as a recommendation for the owner instead.`,
      };
    const jump = from !== null && Math.abs(to - from) > 1;
    const up = from !== null && to > from;
    const budget = up ? await budgetBlock(env, a.allowed_project_ids ?? null, 'model_up', 0) : undefined;
    if (jump) return { ...base, refuse: 'a model changes one tier at a time' };
    return {
      ...base,
      limitReached: recent ? 'one model change per agent per week' : budget,
      data: { agent: a },
    };
  },
  async execute(env, p, pr) {
    const a = pr.data?.agent as Row;
    await patchAgent(env.ctx, env.owner, a.id, { model: p.to, ...(p.effort ? { effort: p.effort } : {}) });
    return {
      message: `${a.name} now runs ${p.to}.`,
      result: { agentId: a.id, from: a.model, to: p.to },
      inverse: {
        kind: 'inverse',
        action: 'model',
        params: { agent: a.id, to: a.model, effort: a.effort ?? undefined },
        preconditions: { model: p.to },
        label: `Move ${a.name} back to ${a.model}`,
      },
    };
  },
};

const SeniorityP = z.object({ agent: z.string().min(1), to: z.enum(['junior', 'senior']) });
const seniority: ActionDef<z.infer<typeof SeniorityP>> = {
  cls: 'agent.change_seniority',
  schema: SeniorityP,
  describe: (p, pr) => `${p.to === 'senior' ? 'Promote' : 'Demote'} ${pr.subjectLabel} to ${p.to}`,
  async prepare(env, p) {
    const a = await agentByName(env.ctx.pool, env.orgId, p.agent);
    if (!a) return refuse(`agent ${p.agent} not found`);
    const base = {
      subjectKind: 'agent',
      subjectId: a.id as string,
      subjectLabel: `${a.name} (${a.role_key})`,
      targetAgentId: a.id as string,
    };
    if (a.status !== 'active' || a.is_devops || a.role_key === 'ceo')
      return { ...base, refuse: `${a.name}'s seniority is not changed this way` };
    if (a.seniority === p.to) return { ...base, refuse: `${a.name} is ${p.to} already` };
    const role = await loadRole(env.ctx.pool, env.orgId, a.role_key, a.role_version);
    if (role && !role.definition.seniorityLevels.includes(p.to))
      return { ...base, refuse: `the ${a.role_key} role has no ${p.to} level` };
    return { ...base, data: { agent: a } };
  },
  async execute(env, p, pr) {
    const a = pr.data?.agent as Row;
    await patchAgent(env.ctx, env.owner, a.id, { seniority: p.to });
    return {
      message: `${a.name} is now ${p.to}.`,
      result: { agentId: a.id, from: a.seniority, to: p.to },
      inverse: {
        kind: 'inverse',
        action: 'seniority',
        params: { agent: a.id, to: a.seniority },
        preconditions: { seniority: p.to },
        label: `Make ${a.name} ${a.seniority} again`,
      },
    };
  },
};

// ----------------------------------------------------------------------------------- allow list, bench

const AllowP = z.object({ agent: z.string().min(1), projects: csv });
const allow: ActionDef<z.infer<typeof AllowP>> = {
  cls: 'agent.allow_list',
  schema: AllowP,
  describe: (p, pr) => `Let ${pr.subjectLabel} work on ${p.projects.join(', ') || 'no project'}`,
  async prepare(env, p) {
    const a = await agentByName(env.ctx.pool, env.orgId, p.agent);
    if (!a) return refuse(`agent ${p.agent} not found`);
    const base = {
      subjectKind: 'agent',
      subjectId: a.id as string,
      subjectLabel: `${a.name} (${a.role_key})`,
      targetAgentId: a.id as string,
    };
    if (a.status !== 'active' || a.is_devops || a.role_key === 'ceo')
      return { ...base, refuse: `${a.name}'s projects are not set this way` };
    const ps = await projectsByKey(env.ctx.pool, env.orgId, p.projects);
    if (typeof ps === 'string') return { ...base, refuse: ps };
    return { ...base, data: { agent: a, ids: ps.map((x) => x.id) } };
  },
  async execute(env, _p, pr) {
    const a = pr.data?.agent as Row;
    const ids = pr.data?.ids as string[];
    await setAgentAllowedProjects(env.ctx, env.owner, a.id, ids);
    return {
      message: `${a.name} works on the listed projects now.`,
      result: { agentId: a.id },
      inverse: {
        kind: 'inverse',
        action: 'allow-restore',
        params: { agent: a.id, projectIds: a.allowed_project_ids ?? null },
        preconditions: {},
        label: `Restore where ${a.name} worked`,
      },
    };
  },
};

const AgentOnlyP = z.object({ agent: z.string().min(1), reason: z.string().max(500).optional() });
const bench: ActionDef<z.infer<typeof AgentOnlyP>> = {
  cls: 'agent.bench',
  schema: AgentOnlyP,
  describe: (_p, pr) => `Bench ${pr.subjectLabel} (no new work; it can be restored)`,
  async prepare(env, p) {
    const a = await agentByName(env.ctx.pool, env.orgId, p.agent);
    if (!a) return refuse(`agent ${p.agent} not found`);
    const base = {
      subjectKind: 'agent',
      subjectId: a.id as string,
      subjectLabel: `${a.name} (${a.role_key})`,
      targetAgentId: a.id as string,
    };
    if (a.status !== 'active' || a.is_devops || a.role_key === 'ceo')
      return { ...base, refuse: `${a.name} cannot be benched` };
    if (Array.isArray(a.allowed_project_ids) && a.allowed_project_ids.length === 0)
      return { ...base, refuse: `${a.name} is benched already` };
    return { ...base, data: { agent: a } };
  },
  async execute(env, _p, pr) {
    const a = pr.data?.agent as Row;
    await setAgentAllowedProjects(env.ctx, env.owner, a.id, []);
    return {
      message: `${a.name} is benched.`,
      result: { agentId: a.id },
      inverse: {
        kind: 'inverse',
        action: 'allow-restore',
        params: { agent: a.id, projectIds: a.allowed_project_ids ?? null },
        preconditions: {},
        label: `Bring ${a.name} back`,
      },
    };
  },
};

const retire: ActionDef<z.infer<typeof AgentOnlyP>> = {
  cls: 'agent.retire',
  schema: AgentOnlyP,
  describe: (_p, pr) => `Retire (let go) ${pr.subjectLabel}`,
  async prepare(env, p) {
    const a = await agentByName(env.ctx.pool, env.orgId, p.agent);
    if (!a) return refuse(`agent ${p.agent} not found`);
    const base = {
      subjectKind: 'agent',
      subjectId: a.id as string,
      subjectLabel: `${a.name} (${a.role_key})`,
      targetAgentId: a.id as string,
    };
    if (a.status !== 'active' || a.is_devops || a.role_key === 'ceo')
      return { ...base, refuse: `${a.name} cannot be retired this way` };
    // D12: firing is "bench first": an agent that is not benched yet is benched, and the owner confirms the retirement.
    const benched = Array.isArray(a.allowed_project_ids) && a.allowed_project_ids.length === 0;
    return {
      ...base,
      ...(benched
        ? {}
        : { refuse: `bench ${a.name} first (aom ceo act bench); retiring follows once the owner confirms` }),
      data: { agent: a },
    };
  },
  async execute(env, _p, pr) {
    const a = pr.data?.agent as Row;
    const r = await fireAgent(env.ctx, env.owner, a.id);
    return {
      message: `${a.name} was let go; ${r.releasedCardIds.length} card(s) went back to the queue.`,
      result: { agentId: a.id },
    };
  },
};

// ------------------------------------------------------------------------------------------ hire, scale

const HireP = z.object({
  role: z.string().min(1).max(60),
  seniority: z.enum(['junior', 'senior']),
  name: z.string().trim().min(1).max(60).optional(),
  workstation: z.string().min(1).max(120),
  projects: csv,
  model: z.string().max(100).optional(),
  effort: z.string().max(20).optional(),
});

async function countHiredToday(env: ActionEnv): Promise<number> {
  const r = await one<{ n: string }>(
    env.ctx.pool,
    `SELECT count(*)::text AS n FROM ceo_actions WHERE org_id=$1 AND class IN ('agent.hire','agent.scale') AND mode='decided' AND status='done' AND created_at > $2`,
    [env.orgId, new Date(env.now.getTime() - 86_400_000)],
  );
  return Number(r?.n ?? 0);
}
async function ceoHiredActive(env: ActionEnv): Promise<number> {
  const r = await one<{ n: string }>(
    env.ctx.pool,
    `SELECT count(DISTINCT a.id)::text AS n FROM agents a
       JOIN ceo_actions x ON x.org_id = a.org_id AND x.mode='decided' AND x.status='done' AND x.result::text LIKE '%' || a.id::text || '%'
      WHERE a.org_id=$1 AND a.status='active' AND x.class IN ('agent.hire','agent.scale')`,
    [env.orgId],
  );
  return Number(r?.n ?? 0);
}
async function roleCountOn(env: ActionEnv, roleKey: string, projectId: string): Promise<number> {
  const r = await one<{ n: string }>(
    env.ctx.pool,
    `SELECT count(*)::text AS n FROM agents WHERE org_id=$1 AND role_key=$2 AND status='active' AND (allowed_project_ids IS NULL OR $3::uuid = ANY(allowed_project_ids))`,
    [env.orgId, roleKey, projectId],
  );
  return Number(r?.n ?? 0);
}

async function hireChecks(
  env: ActionEnv,
  roleKey: string,
  projectIds: string[],
  count: number,
  model?: string,
): Promise<{ refuse?: string; limit?: string }> {
  const role = await loadRole(env.ctx.pool, env.orgId, roleKey);
  if (!role || roleKey === 'ceo' || role.definition.key === 'devops')
    return { refuse: `the role ${roleKey} cannot be hired by the CEO` };
  if (model) {
    const t = modelTier(model);
    const cap = modelTier(role.definition.defaultModel.model);
    if (t === null) return { refuse: `${model} is not a model on the ladder` };
    if (cap !== null && t > cap)
      return {
        refuse: `the model may not be above the role default (${role.definition.defaultModel.model})`,
      };
  }
  if (await hireEvidenceMissing(env))
    return {
      refuse:
        'a hire must cite a current HR recommendation or open signal as evidence (--evidence hr:<id> or signal:<id>)',
    };
  const lim = env.ceo.policy.limits;
  if ((await countHiredToday(env)) + count > lim.maxHiresPerDay)
    return { limit: `${lim.maxHiresPerDay} hires a day` };
  if ((await ceoHiredActive(env)) + count > lim.maxCeoHiredActive)
    return { limit: `${lim.maxCeoHiredActive} CEO-hired agents at most` };
  for (const pid of projectIds)
    if ((await roleCountOn(env, roleKey, pid)) + count > lim.maxAgentsPerRolePerProject)
      return { limit: `${lim.maxAgentsPerRolePerProject} ${roleKey} agents per project at most` };
  const budget = await budgetBlock(env, projectIds, 'hire');
  if (budget) return { limit: budget };
  return {};
}

async function hireOne(
  env: ActionEnv,
  input: z.infer<typeof HireP>,
  ws: Row,
  projectIds: string[],
): Promise<{ id: string; name: string }> {
  const name =
    input.name ??
    (await suggestNames(env.ctx, env.orgId, undefined, 1))[0] ??
    `Agent ${randomUUID().slice(0, 4)}`;
  const body = {
    name,
    roleKey: input.role,
    seniority: input.seniority,
    workstationId: ws.id,
    allowedProjectIds: projectIds,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    capacity: 1,
  };
  const out = await hireAgent(env.ctx, env.owner, { id: env.orgId }, body as never);
  return { id: out, name };
}

const hire: ActionDef<z.infer<typeof HireP>> = {
  cls: 'agent.hire',
  schema: HireP,
  describe: (p) => `Hire a ${p.seniority} ${p.role} for ${p.projects.join(', ')}`,
  async prepare(env, p) {
    const base = {
      subjectKind: 'role',
      subjectId: `${p.role}:${p.projects.join(',')}`,
      subjectLabel: `${p.seniority} ${p.role} for ${p.projects.join(', ')}`,
    };
    const ws = await one(
      env.ctx.pool,
      `SELECT id, name FROM workstations WHERE status='active' AND (lower(name)=lower($2) OR id::text=$2) AND (user_id=$3 OR simulation_org_id=$1)`,
      [env.orgId, p.workstation, env.owner.id],
    );
    if (!ws) return { ...base, refuse: `no workstation named ${p.workstation} of yours` };
    const ps = await projectsByKey(env.ctx.pool, env.orgId, p.projects);
    if (typeof ps === 'string') return { ...base, refuse: ps };
    if (
      p.name &&
      (await one(env.ctx.pool, 'SELECT 1 FROM agents WHERE org_id=$1 AND lower(name)=lower($2)', [
        env.orgId,
        p.name,
      ]))
    )
      return { ...base, refuse: `the name ${p.name} is taken` };
    const c = await hireChecks(
      env,
      p.role,
      ps.map((x) => x.id),
      1,
      p.model,
    );
    if (c.refuse) return { ...base, refuse: c.refuse };
    return { ...base, limitReached: c.limit, data: { ws, ids: ps.map((x) => x.id) } };
  },
  async execute(env, p, pr) {
    const h = await hireOne(env, p, pr.data?.ws as Row, pr.data?.ids as string[]);
    return {
      message: `${h.name} is hired (${p.seniority} ${p.role}).`,
      result: { agentId: h.id, name: h.name },
      inverse: {
        kind: 'inverse',
        action: 'unhire',
        params: { agent: h.id },
        preconditions: { active: true },
        label: `Retire ${h.name} (benched if it has already worked)`,
      },
    };
  },
};

const ScaleP = z.object({
  role: z.string().min(1).max(60),
  project: z.string().min(2).max(10),
  to: z.coerce.number().int().min(0).max(20),
  seniority: z.enum(['junior', 'senior']).default('junior'),
});
const scale: ActionDef<z.infer<typeof ScaleP>> = {
  cls: 'agent.scale',
  schema: ScaleP,
  describe: (p) => `Scale ${p.role} on ${p.project} to ${p.to}`,
  async prepare(env, p) {
    const base = {
      subjectKind: 'role',
      subjectId: `${p.role}:${p.project.toUpperCase()}`,
      subjectLabel: `${p.role} on ${p.project.toUpperCase()}`,
    };
    const ps = await projectsByKey(env.ctx.pool, env.orgId, [p.project]);
    if (typeof ps === 'string') return { ...base, refuse: ps };
    const pid = ps[0]!.id as string;
    const have = await roleCountOn(env, p.role, pid);
    if (p.to === have)
      return { ...base, refuse: `there are ${have} ${p.role} agents on ${p.project.toUpperCase()} already` };
    if (Math.abs(p.to - have) > 2) return { ...base, refuse: 'scale by at most two agents at a time' };
    if (p.to > have) {
      const model = await one(
        env.ctx.pool,
        `SELECT a.workstation_id FROM agents a WHERE a.org_id=$1 AND a.role_key=$2 AND a.status='active' ORDER BY a.hired_at DESC LIMIT 1`,
        [env.orgId, p.role],
      );
      if (!model?.workstation_id)
        return { ...base, refuse: `no ${p.role} agent exists to copy a workstation from: use hire` };
      const ws = await one(
        env.ctx.pool,
        `SELECT id, name FROM workstations WHERE id=$1 AND status='active' AND (user_id=$2 OR simulation_org_id=$3)`,
        [model.workstation_id, env.owner.id, env.orgId],
      );
      if (!ws) return { ...base, refuse: 'the workstation of the existing agents is not one of yours' };
      const c = await hireChecks(env, p.role, [pid], p.to - have);
      if (c.refuse) return { ...base, refuse: c.refuse };
      return { ...base, limitReached: c.limit, data: { pid, have, ws } };
    }
    return { ...base, data: { pid, have } };
  },
  async execute(env, p, pr) {
    const pid = pr.data?.pid as string;
    const have = pr.data?.have as number;
    if (p.to > have) {
      const hired: Array<{ id: string; name: string }> = [];
      for (let i = 0; i < p.to - have; i++)
        hired.push(
          await hireOne(
            env,
            { role: p.role, seniority: p.seniority, workstation: '', projects: [p.project] } as never,
            pr.data?.ws as Row,
            [pid],
          ),
        );
      return {
        message: `${hired.map((h) => h.name).join(', ')} hired.`,
        result: { agentIds: hired.map((h) => h.id) },
        inverse: {
          kind: 'inverse',
          action: 'scale-undo',
          params: { hired: hired.map((h) => h.id) },
          preconditions: {},
          label: `Retire ${hired.map((h) => h.name).join(', ')}`,
        },
      };
    }
    const cands = await rows(
      env.ctx.pool,
      `SELECT a.* FROM agents a WHERE a.org_id=$1 AND a.role_key=$2 AND a.status='active' AND (a.allowed_project_ids IS NULL OR $3::uuid = ANY(a.allowed_project_ids))
        ORDER BY (SELECT count(*) FROM cards c WHERE c.claimed_by_agent_id = a.id AND c.claim_id IS NOT NULL), a.hired_at DESC LIMIT $4`,
      [env.orgId, p.role, pid, have - p.to],
    );
    const reduced: Array<{ agent: string; prev: string[] | null }> = [];
    for (const a of cands) {
      const prev: string[] | null = a.allowed_project_ids ?? null;
      const next =
        prev === null
          ? (
              await rows<{ id: string }>(
                env.ctx.pool,
                `SELECT id FROM projects WHERE org_id=$1 AND kind='project' AND status='active' AND id <> $2`,
                [env.orgId, pid],
              )
            ).map((x) => x.id)
          : prev.filter((x) => x !== pid);
      await setAgentAllowedProjects(env.ctx, env.owner, a.id, next);
      reduced.push({ agent: a.id, prev });
    }
    return {
      message: `${reduced.length} agent(s) no longer work on ${p.project.toUpperCase()}.`,
      result: { agentIds: reduced.map((x) => x.agent) },
      inverse: {
        kind: 'inverse',
        action: 'scale-undo',
        params: { reduced },
        preconditions: {},
        label: 'Restore the previous team',
      },
    };
  },
};

// ------------------------------------------------------------------------------------------- HR rec

const RecP = z.object({ id: z.string().min(1).max(200) });
const REC_CLASS: Record<string, ActionClass> = {
  change_model: 'agent.change_model',
  split_role: 'agent.hire',
  fire: 'agent.retire',
  standing_order: 'standing_order.propose',
};
const applyRec: ActionDef<z.infer<typeof RecP>> = {
  cls: 'hr.apply_recommendation',
  schema: RecP,
  describe: (_p, pr) => `Apply the HR recommendation: ${pr.subjectLabel}`,
  async prepare(env, p) {
    const listed = (await listRecommendations(env.ctx, who(env))).find((l) => l.rec.id === p.id);
    if (!listed) return refuse('that recommendation no longer applies');
    const rec = listed.rec;
    const base = { subjectKind: 'hr', subjectId: rec.id, subjectLabel: truncate(rec.title, 120) };
    if (rec.action.type === 'none' || !rec.canApply)
      return { ...base, refuse: 'this recommendation is advice only' };
    return { ...base, classOverride: REC_CLASS[rec.action.type] ?? 'hr.apply_recommendation', data: { rec } };
  },
  async execute(env, p, pr) {
    const rec = pr.data?.rec as {
      action: { type: string; agentId?: string; fromModel?: string };
      agentName?: string;
    };
    const out = await applyRecommendation(env.ctx, env.owner, who(env), p.id);
    const inverse: CeoInverse | undefined =
      rec.action.type === 'change_model' && rec.action.agentId && rec.action.fromModel
        ? {
            kind: 'inverse',
            action: 'model',
            params: { agent: rec.action.agentId, to: rec.action.fromModel },
            preconditions: {},
            label: `Back to ${rec.action.fromModel}`,
          }
        : undefined;
    return { message: out.effect, result: { effect: out.effect, agentIds: out.agentIds }, inverse };
  },
};

// ------------------------------------------------------------------------------------ standing orders

const OrderP = z.object({
  scope: z.enum(['org', 'project']).default('org'),
  project: z.string().max(10).optional(),
  /** The card the order comes from (an answer on a card): such an order stays at the card's project, never org-wide. */
  card: z.string().max(40).optional(),
  text: z.string().trim().min(10).max(4000),
  title: z.string().trim().max(120).optional(),
});
async function orderTarget(
  env: ActionEnv,
  p: z.infer<typeof OrderP>,
): Promise<{ projectId: string | null } | string> {
  // Decisions that come from a card are project decisions: the owner alone promotes one to the organization.
  if (p.card) {
    const card = await cardOf(env.ctx.pool, env, p.card);
    if (!card) return `card ${p.card} not found`;
    return { projectId: card.project_id as string };
  }
  if (p.scope === 'org' && !p.project) return { projectId: null };
  if (!p.project) return 'a project order needs --project';
  const ps = await projectsByKey(env.ctx.pool, env.orgId, [p.project]);
  return typeof ps === 'string' ? ps : { projectId: ps[0]!.id };
}

/** The refusal text when a live order already says the same (the CEO does not add duplicates). */
async function duplicateOrder(
  env: ActionEnv,
  projectId: string | null,
  p: z.infer<typeof OrderP>,
): Promise<string | undefined> {
  const live = await rows<{ id: string; title: string; body: string }>(
    env.ctx.pool,
    `SELECT id, title, body FROM ledger_entries
      WHERE org_id=$1 AND scope='standing_order' AND superseded_by IS NULL AND retired_at IS NULL
        AND (project_id IS NULL OR project_id IS NOT DISTINCT FROM $2::uuid)`,
    [env.orgId, projectId],
  );
  const hit = live.find((o) => isNearDuplicate({ title: p.title ?? truncate(p.text, 100), body: p.text }, o));
  return hit ? `a standing order that says the same already exists: "${hit.title}" (${hit.id})` : undefined;
}

const proposeOrder: ActionDef<z.infer<typeof OrderP>> = {
  cls: 'standing_order.propose',
  schema: OrderP,
  describe: (p) => `Propose a standing order: ${truncate(p.text, 100)}`,
  async prepare(env, p) {
    const base = { subjectKind: 'order', subjectId: '', subjectLabel: truncate(p.text, 100) };
    const t = await orderTarget(env, p);
    if (typeof t === 'string') return { ...base, refuse: t };
    const dup = await duplicateOrder(env, t.projectId, p);
    return dup ? { ...base, refuse: dup } : { ...base, data: t };
  },
  async execute(env, p, pr) {
    const deskItemId = randomUUID();
    const projectId = (pr.data as { projectId: string | null }).projectId;
    await appendLocked(env, [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'approval',
            subkind: 'standing_order',
            title: `Add a standing order: ${p.title ?? truncate(p.text, 80)}`,
            body: p.text,
            options: [],
            blocking: false,
            pinned: false,
            affectedCardIds: [],
            ...(projectId ? { projectId } : {}),
            askedBy: ceoBy(env),
          },
        },
        actor: userActor(env.owner.id),
        scope: projectId ? { orgId: env.orgId, projectId, audience: 'project' } : orgScope(env.orgId),
      },
    ]);
    return {
      message: "Proposed on the owner's desk.",
      result: { deskItemId },
      inverse: {
        kind: 'inverse',
        action: 'dismiss-item',
        params: { item: deskItemId },
        preconditions: {},
        label: 'Withdraw the proposal',
      },
    };
  },
};

const activateOrder: ActionDef<z.infer<typeof OrderP>> = {
  cls: 'standing_order.activate',
  schema: OrderP,
  describe: (p) => `Activate the standing order: ${truncate(p.text, 100)}`,
  async prepare(env, p) {
    const base = { subjectKind: 'order', subjectId: '', subjectLabel: truncate(p.text, 100) };
    const t = await orderTarget(env, p);
    if (typeof t === 'string') return { ...base, refuse: t };
    const dup = await duplicateOrder(env, t.projectId, p);
    return dup ? { ...base, refuse: dup } : { ...base, data: t };
  },
  async execute(env, p, pr) {
    const entryId = randomUUID();
    const projectId = (pr.data as { projectId: string | null }).projectId;
    await appendLocked(env, [
      {
        streamId: streamId.ledger(entryId),
        event: {
          type: 'LedgerEntryAdded',
          payload: {
            entryId,
            scope: 'standing_order',
            ...(projectId ? { projectId } : {}),
            title: p.title ?? truncate(p.text, 100),
            body: p.text,
            tags: ['ceo'],
          },
        },
        actor: userActor(env.owner.id),
        scope: projectId ? { orgId: env.orgId, projectId, audience: 'project' } : orgScope(env.orgId),
      },
    ]);
    return { message: 'The standing order is active.', result: { entryId } };
  },
};

const RetireP = z.object({
  entry: z.uuid(),
  text: z.string().trim().min(3).max(1000),
  supersededBy: z.uuid().optional(),
});
const retireEntry: ActionDef<z.infer<typeof RetireP>> = {
  cls: 'standing_order.retire',
  schema: RetireP,
  describe: (p) => `Retire the ledger entry ${p.entry}: ${truncate(p.text, 100)}`,
  async prepare(env, p) {
    const e = await one(env.ctx.pool, 'SELECT title, org_id, retired_at FROM ledger_entries WHERE id=$1', [
      p.entry,
    ]);
    const base = {
      subjectKind: 'order',
      subjectId: p.entry,
      subjectLabel: truncate(e?.title ?? p.entry, 100),
    };
    if (!e || e.org_id !== env.orgId) return { ...base, refuse: 'ledger entry not found' };
    if (e.retired_at) return { ...base, refuse: 'that entry is already retired' };
    return base;
  },
  async execute(env, p) {
    await retireLedgerEntryAs(
      env.ctx,
      p.entry,
      { reason: p.text, supersededBy: p.supersededBy },
      { actor: userActor(env.owner.id), label: 'ceo', orgId: env.orgId },
    );
    return { message: 'The entry is retired.', result: { entryId: p.entry } };
  },
};

// --------------------------------------------------------------------------------------------- intake

const IntakeP = z.object({
  project: z.string().min(2).max(10),
  text: z.string().trim().min(10).max(8000),
  title: z.string().trim().max(300).optional(),
  investigation: z.coerce.boolean().optional(),
  /** What kind of card (default `feature`). An investigation is the `investigation` flag, not a card type. */
  cardType: z.enum(['feature', 'bug', 'support', 'refactor', 'docs']).default('feature'),
  /** The external reference (a Jira key, an issue URL): kept on the card as its `externalRef`. */
  ticket: z.string().trim().max(200).optional(),
  priority: z.coerce.number().int().min(1).max(9).optional(),
});

/**
 * What became of a draft that `specify:true` could not specify: the BA completes it when it can (a `spec_card` task), and
 * the CEO is told plainly when it cannot (a missing repository needs a person; no BA means "hire one").
 */
async function completeDraft(
  env: ActionEnv,
  tx: Tx,
  cardId: string,
  missing: string[],
): Promise<{ queued: boolean; text: string }> {
  const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [cardId])) as Row;
  const { other } = await splitMissing(tx, card, missing);
  if (other.length)
    return {
      queued: false,
      text: `it stays a draft: it needs ${missingText(other)}, which only a person can add (the BA cannot)`,
    };
  if (!(await hasActiveBa(tx, env.orgId)))
    return {
      queued: false,
      text: `it stays a draft: missing ${missingText(missing)} and there is no BA to write it. Recommend hiring a BA`,
    };
  await queueSpecCardTask(env.ctx, tx, card, userActor(env.owner.id));
  return { queued: true, text: `sent to the BA to complete: ${missingText(missing)}` };
}

const intake: ActionDef<z.infer<typeof IntakeP>> = {
  cls: 'card.create_via_ba',
  schema: IntakeP,
  describe: (p) => `Ask the BA to take on in ${p.project.toUpperCase()}: ${truncate(p.text, 100)}`,
  async prepare(env, p) {
    const base = {
      subjectKind: 'project',
      subjectId: '',
      subjectLabel: `${p.project.toUpperCase()}: ${truncate(p.text, 80)}`,
    };
    const ps = await projectsByKey(env.ctx.pool, env.orgId, [p.project]);
    if (typeof ps === 'string') return { ...base, refuse: ps };
    return { ...base, subjectId: ps[0]!.id as string, data: { pid: ps[0]!.id } };
  },
  async execute(env, p, pr) {
    const { createCardIn } = await import('../commands/cards.ts');
    const title = p.title ?? truncate(p.text.split('\n')[0] ?? p.text, 120);
    const out = await withAppendTx(env.ctx.pool, async (tx) => {
      const r = await createCardIn(env.ctx, tx, env.owner, {
        projectId: pr.data?.pid as string,
        title,
        cardType: p.cardType,
        fields: { context: p.text, ...(p.ticket ? { externalRef: p.ticket } : {}) },
        specify: true,
        ...(p.priority ? { priority: p.priority } : {}),
        ...(p.investigation ? { investigationOnly: true } : {}),
      } as never);
      const next = r.missing?.length ? await completeDraft(env, tx, r.cardId, r.missing) : undefined;
      return { r, next };
    });
    const card = await one(env.ctx.pool, 'SELECT ref FROM cards WHERE id=$1', [out.r.cardId]);
    return {
      message: `${card?.ref ?? 'A card'} was drafted${out.next ? `: ${out.next.text}` : ' and specified'}.`,
      result: {
        cardId: out.r.cardId,
        ref: card?.ref,
        specified: !out.next,
        baQueued: out.next?.queued ?? false,
      },
      inverse: {
        kind: 'inverse',
        action: 'cancel-draft',
        params: { card: out.r.cardId },
        preconditions: {},
        label: `Cancel ${card?.ref ?? 'the draft'}`,
      },
    };
  },
};

// -------------------------------------------------------------------------------------------- specify

const SpecifyP = z.object({ card: z.string().min(1).max(40) });
const specify: ActionDef<z.infer<typeof SpecifyP>> = {
  cls: 'card.specify',
  schema: SpecifyP,
  describe: (_p, pr) => `Specify ${pr.subjectLabel}`,
  async prepare(env, p) {
    const card = await cardOf(env.ctx.pool, env, p.card);
    if (!card) return refuse(`card ${p.card} not found`);
    const base = {
      subjectKind: 'card',
      subjectId: card.id as string,
      subjectLabel: `${card.ref} ${truncate(card.title, 80)}`,
    };
    if (card.status !== 'draft')
      return { ...base, refuse: `${card.ref} is ${card.status}: only a draft is specified` };
    return { ...base, data: { card } };
  },
  async execute(env, _p, pr) {
    const id = (pr.data as { card: Row }).card.id as string;
    const out = await withAppendTx(env.ctx.pool, async (tx) => {
      const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [id])) as Row;
      if (card.status !== 'draft')
        return { kind: 'moved' as const, ref: card.ref as string, status: card.status as string };
      const missing = await cardMissing(tx, card);
      if (missing.length === 0) {
        await specifyCardIn(env.ctx, tx, env.owner, id);
        return { kind: 'specified' as const, ref: card.ref as string };
      }
      return {
        kind: 'missing' as const,
        ref: card.ref as string,
        ...(await completeDraft(env, tx, id, missing)),
      };
    });
    if (out.kind === 'moved')
      return { message: `${out.ref} is ${out.status} already.`, result: { cardId: id } };
    if (out.kind === 'specified')
      return {
        message: `${out.ref} is specified: it is in the queue.`,
        result: { cardId: id, specified: true },
      };
    return {
      message: `${out.ref}: ${out.text}.`,
      result: { cardId: id, specified: false, baQueued: out.queued },
    };
  },
};

export const ACTIONS2: Partial<Record<CeoActionName, ActionDef>> = {
  reassign,
  'cancel-card': cancelCardAction,
  model: modelAction,
  seniority,
  allow,
  bench,
  retire,
  hire,
  scale,
  'apply-rec': applyRec,
  'propose-order': proposeOrder,
  'activate-order': activateOrder,
  'retire-entry': retireEntry,
  intake,
  specify,
};

void conflict;
void deskItem;

export type { Executed, Prepared };
