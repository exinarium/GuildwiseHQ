import { randomUUID } from 'node:crypto';
import {
  BUILTIN_ROLES,
  type HirePackAgentsRequest,
  type HirePackAgentsResponse,
  humaniseKey,
  isOrgManager,
  PACK_SEAT_KEYS,
  type PackClassification,
  type PackItem,
  type PackPersonaRef,
  type PackSnapshot,
  type PackTeamAgentDto,
  type PackTeamResponse,
  RoleDefinitionSchema,
  roleForPackAgent,
  runnerAtLeast,
  type Seniority,
  streamId,
  suggestSeat,
  validateRoleDefinition,
} from '@aom/shared';
import type { Who } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadRole } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { assertWithinLimit } from '../orgs/limits.ts';
import { hireAgentIn } from './agents.ts';
import { orgScope, userActor } from './common.ts';
import { BUILTIN_ROLE_KEYS, BUILTIN_WORKFLOW_KEYS, nextVersion } from './designer.ts';
import { isTrustedRow, packEvent, pluginItemAwaiting } from './pack-support.ts';

/**
 * Pack agents on seats and the whole team of a pack (docs/ARCHITECTURE.md section 38.14). A pack agent is a persona, or a skill
 * the Owner marked as an agent (`PackItemsClassified`). Hired onto a built-in role as its seat it keeps the role's rules, gates,
 * permissions and model defaults and joins the agents already there; it inherits the pack agent's name and, for a skill agent,
 * the skill. The server holds metadata only: the pack's text stays in the pack, the agent loads it with `aom skill show`.
 */

const MAX_INSTANCES = 60;

/** The first runner that reads the pack agent fields of a brief. */
export const MIN_RUNNER_FOR_PACK_SEATS = '0.1.62';

const shortKey = (packName: string, key: string): string =>
  key.startsWith(`${packName}:`) ? key.slice(packName.length + 1) : key;

/**
 * Organization packs only: a private pack's agents keep the older "hire from pack" (they need the owner's grant to be loaded).
 * A pack added to one project is visible only to people on that project, like in the registry.
 */
async function orgPack(db: Queryable, who: Who, packId: string): Promise<Row> {
  const p = await one(
    db,
    `SELECT * FROM packs WHERE id=$1 AND org_id=$2 AND removed_at IS NULL AND visibility='org'`,
    [packId, who.orgId],
  );
  if (!p) throw notFound('pack not found');
  if (p.scope === 'project') {
    const on = p.project_id
      ? await one(
          db,
          `SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`,
          [p.project_id, who.userId],
        )
      : null;
    if (!on) throw notFound('pack not found');
  }
  return p;
}

const snapshotOf = (p: Row): PackSnapshot | null => (p.snapshot as PackSnapshot | null) ?? null;
const classificationOf = (p: Row): PackClassification => {
  const c = p.classification as Partial<PackClassification> | null;
  return { agents: c?.agents ?? [], playbooks: c?.playbooks ?? [] };
};

export interface PackAgentDescriptor {
  key: string;
  kind: 'persona' | 'skill';
  item: PackItem;
  name: string;
  marked: boolean;
}

/**
 * The default name of a pack agent, as it enters "You are <name>" in unfenced instructions: at most three plain words of letters
 * and digits (a first name, a title). Anything else a pack puts there (sentences, punctuation, line breaks, an instruction) is
 * not used: the name is made from the key, which is lowercase letters, digits and hyphens.
 */
export function safeAgentName(raw: string, fallback: string): string {
  const t = raw.trim();
  const words = t.split(/ +/);
  const plain = /^[\p{L}\p{N}][\p{L}\p{N}.'-]*$/u;
  if (t.length > 0 && t.length <= 30 && words.length <= 3 && words.every((w) => plain.test(w))) return t;
  return fallback.split(' ').slice(0, 3).join(' ').slice(0, 30).trim() || 'Agent';
}

/** What a hire gets besides the seat's skills when the request names none: the persona's own declared skills of this pack. */
const defaultSkillsOf = (
  a: PackAgentDescriptor,
  skillKeys: ReadonlySet<string>,
  agentKeys: ReadonlySet<string>,
): string[] =>
  (a.item.declaredSkills ?? []).filter((k) => skillKeys.has(k) && !agentKeys.has(k) && k !== a.key);

/** The pack's agents: its personas, and the skills the Owner marked as agents. */
export function packAgentsOf(p: Row): PackAgentDescriptor[] {
  const items = snapshotOf(p)?.items ?? [];
  const marked = new Set(classificationOf(p).agents);
  const out: PackAgentDescriptor[] = [];
  for (const i of items) {
    if (pluginItemAwaiting(p, i)) continue;
    const key = shortKey(p.name, i.key);
    if (i.kind === 'persona') out.push({ key, kind: 'persona', item: i, name: i.name, marked: false });
    else if (i.kind === 'skill' && marked.has(key))
      out.push({ key, kind: 'skill', item: i, name: i.displayName ?? humaniseKey(key), marked: true });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ classification

/**
 * `PUT /api/packs/:id/classification`: the Owner or an Admin says which of an approved pack's skills are agents and which are
 * playbooks. Full lists; every key must be a skill of the pack; a skill cannot be both. Metadata only.
 */
export async function classifyPack(
  ctx: Ctx,
  who: Who,
  packId: string,
  req: PackClassification,
): Promise<PackClassification> {
  if (!isOrgManager({ orgRole: who.role }))
    throw forbidden('only owners and admins classify the skills of a pack');
  return withAppendTx(ctx.pool, async (tx) => {
    const p = await one(
      tx,
      `SELECT * FROM packs WHERE id=$1 AND org_id=$2 AND removed_at IS NULL AND visibility='org' FOR UPDATE`,
      [packId, who.orgId],
    );
    if (!p) throw notFound('pack not found');
    if (!p.pinned_sha || !isTrustedRow(p))
      throw conflict('pack_not_trusted', 'approve the pack before you classify its skills');
    const skills = new Set(
      (snapshotOf(p)?.items ?? []).filter((i) => i.kind === 'skill').map((i) => shortKey(p.name, i.key)),
    );
    const agents = [...new Set(req.agents)].sort();
    const playbooks = [...new Set(req.playbooks)].sort();
    for (const k of [...agents, ...playbooks])
      if (!skills.has(k)) throw badRequest('unknown_skill', `the pack has no skill "${k}"`);
    for (const k of agents)
      if (playbooks.includes(k))
        throw badRequest('conflicting_classification', `"${k}" cannot be both an agent and a playbook`);
    const cur = classificationOf(p);
    const same =
      JSON.stringify([...cur.agents].sort()) === JSON.stringify(agents) &&
      JSON.stringify([...cur.playbooks].sort()) === JSON.stringify(playbooks);
    if (!same)
      await ctx.store.append(
        [
          packEvent(
            'PackItemsClassified',
            { packId, orgId: who.orgId, agents, playbooks, by: who.userId },
            p,
            who.userId,
          ),
        ],
        { tx },
      );
    return { agents, playbooks };
  });
}

// ------------------------------------------------------------------------------------------------ the team

const SEAT_NAMES = new Map(BUILTIN_ROLES.map((r) => [r.key, r.name]));

export async function packTeam(ctx: Ctx, who: Who, packId: string): Promise<PackTeamResponse> {
  const p = await orgPack(ctx.pool, who, packId);
  const trusted = !!p.pinned_sha && isTrustedRow(p);
  // an organization pack that is not approved is for the managers to review; others see nothing to hire from it yet
  const show = trusted || isOrgManager({ orgRole: who.role });
  const cls = classificationOf(p);
  const hired = await rows(
    ctx.pool,
    `SELECT id, pack_persona->>'key' AS key FROM agents
      WHERE org_id=$1 AND status <> 'retired' AND pack_persona->>'packId' = $2`,
    [who.orgId, packId],
  );
  const items = snapshotOf(p)?.items ?? [];
  const agentKeys = new Set(packAgentsOf(p).map((a) => a.key));
  const skillItems = items.filter((i) => i.kind === 'skill');
  const skillKeys = new Set(skillItems.map((i) => shortKey(p.name, i.key)));
  const agents: PackTeamAgentDto[] = show
    ? packAgentsOf(p).map((a) => ({
        key: a.key,
        kind: a.kind,
        name: a.name,
        description: a.item.description,
        icon: a.item.icon ?? null,
        suggestedSeat: suggestSeat({ key: a.key, name: a.name, description: a.item.description }),
        skillRefs: (a.item.skillRefs ?? []).filter(
          (k) => skillKeys.has(k) && !agentKeys.has(k) && k !== a.key,
        ),
        defaultSkills: defaultSkillsOf(a, skillKeys, agentKeys),
        agentSkill: a.kind === 'skill' ? a.key : null,
        hiredAgentIds: hired.filter((h) => h.key === a.key).map((h) => h.id as string),
        marked: a.marked,
        group: a.item.group ?? null,
      }))
    : [];
  return {
    packId,
    packName: p.name,
    trusted,
    seats: PACK_SEAT_KEYS.map((key) => ({ key, name: SEAT_NAMES.get(key) ?? key })),
    agents,
    skills: show
      ? skillItems
          .filter((i) => !pluginItemAwaiting(p, i))
          .map((i) => {
            const key = shortKey(p.name, i.key);
            return {
              key,
              name: i.displayName ?? i.name,
              description: i.description,
              class: cls.agents.includes(key)
                ? ('agent' as const)
                : cls.playbooks.includes(key)
                  ? ('playbook' as const)
                  : ('skill' as const),
              marked: cls.agents.includes(key) || cls.playbooks.includes(key),
              group: i.group ?? null,
            };
          })
      : [],
    pendingPluginItems: items.filter((i) => pluginItemAwaiting(p, i)).length,
    classification: cls,
  };
}

// ------------------------------------------------------------------------------------------------ hiring

/** The role of its own for a pack agent (`seat: 'own'`): created on first use, reused after, never holding pack text. */
async function ensureOwnRole(
  ctx: Ctx,
  tx: Tx,
  orgId: string,
  userId: string,
  p: Row,
  a: PackAgentDescriptor,
): Promise<string> {
  const snap = snapshotOf(p) as PackSnapshot;
  const def = roleForPackAgent({
    packId: p.id,
    packName: p.name,
    key: a.key,
    kind: a.kind,
    hash: a.item.hash,
    sha: p.pinned_sha,
    ref: snap.ref ?? null,
    version: 1,
  });
  if ((BUILTIN_ROLE_KEYS as readonly string[]).includes(def.key))
    throw badRequest('builtin_key', `'${def.key}' is a built-in role: rename the pack`);
  const existing = await loadRole(tx, orgId, def.key);
  if (existing) {
    // only a role of this kind: the older hire-from-pack makes roles that hold a persona's text, and they are not reused here
    if (existing.definition.source?.packId === p.id && existing.definition.source?.roleKind === 'agent')
      return existing.definition.key;
    throw conflict(
      'role_key_taken',
      `a role '${def.key}' already exists and was not made from this pack: rename the pack and try again`,
    );
  }
  const version = await nextVersion(tx as never, 'role_definitions', orgId, def.key);
  const full = { ...def, version };
  const issues = validateRoleDefinition(full, {
    builtinRoleKeys: BUILTIN_ROLE_KEYS,
    builtinWorkflowKeys: BUILTIN_WORKFLOW_KEYS,
    departments: [],
  }).filter((i) => i.severity === 'error');
  if (issues.length)
    throw badRequest('invalid_agent', `"${a.key}" cannot become a role: ${issues[0]?.message}`);
  await ctx.store.append(
    [
      {
        streamId: streamId.role(orgId, def.key),
        event: {
          type: 'RoleVersionRegistered',
          payload: {
            roleVersionId: randomUUID(),
            orgId,
            key: def.key,
            version,
            definition: RoleDefinitionSchema.parse(full),
            status: 'active',
            draftedBy: { kind: 'user', id: userId },
          },
        },
        actor: userActor(userId),
        scope: orgScope(orgId),
      } as AppendInput,
    ],
    { tx },
  );
  return def.key;
}

/**
 * Hires pack agents onto seats, in one transaction: either every agent is hired or none. `team` is the whole-pack call (Owner
 * and Admin only); the single call is open to anyone who may hire (a Member names the projects they are on). The plan limit
 * is checked once for the total. The hires run as the caller, on the caller's own workstation.
 */
export async function hirePackAgents(
  ctx: Ctx,
  user: AuthSession['user'],
  who: Who,
  packId: string,
  req: HirePackAgentsRequest,
  mode: 'agents' | 'team',
): Promise<HirePackAgentsResponse> {
  const manager = isOrgManager({ orgRole: who.role });
  if (mode === 'team' && !manager) throw forbidden('only owners and admins hire a whole pack');
  if (!manager && !req.allowedProjectIds?.length)
    throw forbidden('you cannot hire agents here: choose a project you are on, or ask an Owner or Admin');
  const total = req.items.reduce((n, i) => n + i.count, 0);
  if (total > MAX_INSTANCES) throw badRequest('too_many', `hire at most ${MAX_INSTANCES} agents in one go`);
  const hireId = randomUUID();
  const agents: HirePackAgentsResponse['agents'] = [];
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await orgPack(tx, who, packId);
    if (p.scope === 'project' && !(req.allowedProjectIds ?? []).includes(p.project_id))
      throw badRequest(
        'project_pack',
        'this pack belongs to one project: hire for that project (allowedProjectIds)',
      );
    // The seat's instructions and the brief block need a runner that knows them; an older one would hire an agent that ignores them.
    const ws = await one(tx, 'SELECT runner_version FROM workstations WHERE id=$1 AND user_id=$2', [
      req.workstationId,
      user.id,
    ]);
    if (!ws) throw notFound('workstation not found');
    if (!runnerAtLeast(ws.runner_version, MIN_RUNNER_FOR_PACK_SEATS))
      throw conflict(
        'runner_too_old',
        `the runner on that workstation (${ws.runner_version ?? 'unknown'}) is older than ${MIN_RUNNER_FOR_PACK_SEATS}: update it, or choose another workstation`,
      );
    if (!p.pinned_sha || !isTrustedRow(p))
      throw conflict('pack_not_trusted', 'the pack has to be approved before agents can be hired from it');
    const snap = snapshotOf(p) as PackSnapshot;
    if (req.allowedProjectIds?.length) {
      const ok = await rows(tx, `SELECT id FROM projects WHERE org_id=$1 AND id = ANY($2::uuid[])`, [
        who.orgId,
        req.allowedProjectIds,
      ]);
      if (ok.length !== new Set(req.allowedProjectIds).size)
        throw badRequest('unknown_project', 'every project has to belong to this organization');
    }
    const available = new Map(packAgentsOf(p).map((a) => [a.key, a]));
    const skillKeys = new Set(
      snap.items.filter((i) => i.kind === 'skill').map((i) => shortKey(p.name, i.key)),
    );
    // Resolve everything before the first write, so a bad item changes nothing.
    const plan = req.items.map((it) => {
      const a = available.get(it.key);
      if (!a) throw badRequest('unknown_agent', `the pack has no agent "${it.key}"`);
      for (const s of it.skills ?? [])
        if (!skillKeys.has(s)) throw badRequest('unknown_skill', `the pack has no skill "${s}"`);
      // Omitted: the persona's own declared skills. What the files merely mention (`skillRefs`) is a hint for the form, never granted.
      const chosen = it.skills ?? defaultSkillsOf(a, skillKeys, new Set(available.keys()));
      const skills = [
        ...new Set([...(a.kind === 'skill' ? [a.key] : []), ...chosen].map((k) => `${p.name}:${k}`)),
      ];
      return { it, a, skills };
    });
    await assertWithinLimit(ctx, tx, who.orgId, 'agents', total);
    const taken = new Set(
      (await rows(tx, 'SELECT lower(name) AS n FROM agents WHERE org_id=$1', [who.orgId])).map(
        (r) => r.n as string,
      ),
    );
    const free = (base: string): string => {
      let n = base;
      for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${base.slice(0, 56)} ${i}`;
      taken.add(n.toLowerCase());
      return n;
    };
    for (const { it, a, skills } of plan) {
      const seatRole = it.seat === 'own' ? null : await loadRole(tx, who.orgId, it.seat);
      if (it.seat !== 'own' && !seatRole)
        throw badRequest('unknown_role', `role '${it.seat}' does not exist`);
      const seniority: Seniority =
        it.seniority ??
        (seatRole && !seatRole.definition.seniorityLevels.includes('senior')
          ? (seatRole.definition.seniorityLevels[0] as Seniority)
          : 'senior');
      const defaultName = safeAgentName(a.name, humaniseKey(a.key));
      for (let c = 0; c < it.count; c++) {
        let name: string;
        if (it.name && c === 0) {
          if (taken.has(it.name.toLowerCase()))
            throw conflict('name_taken', `the name '${it.name}' is already used in this organization`);
          taken.add(it.name.toLowerCase());
          name = it.name;
        } else name = free(it.name ?? defaultName);
        const ref: PackPersonaRef = {
          packId: p.id,
          packName: p.name,
          key: a.key,
          kind: a.kind,
          name: a.name.slice(0, 100),
          sha: p.pinned_sha,
          hash: a.item.hash,
          ref: snap.ref ?? null,
        };
        const agentId = randomUUID();
        const own = it.seat === 'own';
        const made = await hireAgentIn(
          ctx,
          tx,
          user,
          { id: who.orgId },
          {
            name,
            roleKey: own ? '' : it.seat,
            seniority,
            workstationId: req.workstationId,
            ...(req.allowedProjectIds !== undefined ? { allowedProjectIds: req.allowedProjectIds } : {}),
            ...(req.runtime ? { runtime: req.runtime } : {}),
            ...(it.model ? { model: it.model } : {}),
            ...(req.effort ? { effort: req.effort } : {}),
            capacity: req.capacity,
            ...(req.acknowledgeUnsandboxed ? { acknowledgeUnsandboxed: true } : {}),
          },
          {
            packPersona: ref,
            addSkills: skills,
            // the role of its own is read only, and so is the agent: a pack's declared tools never widen anything
            ...(own
              ? { roleKeyOf: async (t: Tx, orgId: string) => ensureOwnRole(ctx, t, orgId, user.id, p, a) }
              : {}),
          },
          agentId,
        );
        agents.push({
          agentId,
          name,
          roleKey: made.roleKey,
          seat: it.seat,
          key: a.key,
          kind: a.kind,
          skills: made.skills,
        });
      }
    }
    await ctx.store.append(
      [
        packEvent(
          'PackTeamHired',
          {
            hireId,
            packId,
            orgId: who.orgId,
            by: user.id,
            mode,
            agents: agents.map((x) => ({ agentId: x.agentId, name: x.name, key: x.key, seat: x.seat })),
          },
          p,
          user.id,
        ),
      ],
      { tx },
    );
  });
  return { hireId, packId, agents };
}
