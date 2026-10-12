import { randomUUID } from 'node:crypto';
import {
  BA_ROLE_KEY,
  type CardDraft,
  CardDraftPatchSchema,
  CardDraftSchema,
  type CreateCardRequest,
  type CreateIntakeRequest,
  type ExternalSystem,
  type IntakeContext,
  type IntakeDto,
  IntakeMapParamsSchema,
  IntakeUnmappedParamsSchema,
  isOrgManager,
  type OrgRole,
  type PatchCardRequest,
  parseExternalRef,
  requiredMissing,
  streamId,
  UNMAPPED_TICKET_SUBKIND,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadWorkflowById } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, HttpError, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { dedupMatches } from '../queries/ledger.ts';
import { cardView, createCardIn, patchCardIn, specifyCardIn, specifyTarget } from './cards.ts';
import { agentActor, cardMessage, orgScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { phaseChatRpc, proposeCardPhaseIn } from './phases.ts';

/** Reply of a chat-scoped rpc: `[ok, result?, error?]` (the gateway turns it into `rpc.response`). */
export type RpcReply = [boolean, unknown?, string?];

const pseudoUser = (userId: string): AuthSession['user'] => ({ id: userId }) as AuthSession['user'];

// ------------------------------------------------------------------------------------------- queries

const INTAKE_SELECT = `
SELECT i.*, a.name AS ba_name, a.workstation_id AS ba_workstation_id, a.status AS ba_status, p.key AS project_key
  FROM intakes i JOIN agents a ON a.id = i.ba_agent_id LEFT JOIN projects p ON p.id = i.mapped_project_id`;

async function toDto(ctx: Ctx, list: Row[]): Promise<IntakeDto[]> {
  if (list.length === 0) return [];
  const cards = await rows(
    ctx.pool,
    `SELECT ic.intake_id, c.id, c.ref, c.title, c.stage, c.status, p.key AS project_key
       FROM intake_cards ic JOIN cards c ON c.id = ic.card_id JOIN projects p ON p.id = c.project_id
      WHERE ic.intake_id = ANY($1::uuid[]) ORDER BY ic.created_at, c.number`,
    [list.map((r) => r.id)],
  );
  return list.map((r) => ({
    id: r.id,
    threadId: r.thread_id,
    externalSystem: r.external_system,
    externalKey: r.external_key,
    status: r.status,
    mappedProjectId: r.mapped_project_id,
    mappedProjectKey: r.project_key,
    mappingDeskItemId: r.mapping_desk_item_id,
    baAgentId: r.ba_agent_id,
    baAgentName: r.ba_name,
    workstationOnline:
      r.ba_status === 'active' && !!r.ba_workstation_id && ctx.services.runners.isOnline(r.ba_workstation_id),
    cards: cards
      .filter((c) => c.intake_id === r.id)
      .map((c) => ({
        id: c.id,
        ref: c.ref,
        title: c.title,
        stage: c.stage,
        status: c.status,
        projectKey: c.project_key,
      })),
    createdAt: iso(r.created_at) as string,
  }));
}

export async function listIntakes(ctx: Ctx, orgId: string): Promise<IntakeDto[]> {
  return toDto(
    ctx,
    await rows(ctx.pool, `${INTAKE_SELECT} WHERE i.org_id = $1 ORDER BY i.created_at DESC, i.id LIMIT 100`, [
      orgId,
    ]),
  );
}

export async function getIntake(ctx: Ctx, orgId: string, id: string): Promise<IntakeDto> {
  const r = await one(ctx.pool, `${INTAKE_SELECT} WHERE i.id = $1 AND i.org_id = $2`, [id, orgId]);
  if (!r) throw notFound('intake not found');
  return (await toDto(ctx, [r]))[0] as IntakeDto;
}

/** Projects the user may map a ticket to: the organization's own first, then the ones shared with them. */
async function visibleProjects(db: Queryable, userId: string, orgId: string): Promise<Row[]> {
  return rows(
    db,
    `SELECT p.id, p.key, p.name, p.org_id,
            COALESCE((SELECT array_agg(r.name ORDER BY r.name) FROM project_repos r WHERE r.project_id = p.id AND r.removed_at IS NULL), '{}') AS repos
       FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = $1 AND m.status = 'active'
      WHERE p.status = 'active' AND p.kind = 'project' ORDER BY (p.org_id = $2) DESC, p.key`,
    [userId, orgId],
  );
}

/** What the BA's chat knows about this intake (handed to the runner with every message). */
export async function intakeContext(ctx: Ctx, threadId: string): Promise<IntakeContext | undefined> {
  const i = await one(ctx.pool, `${INTAKE_SELECT} WHERE i.thread_id = $1`, [threadId]);
  if (!i) return undefined;
  const fromChat = !!(await one(ctx.pool, `SELECT 1 FROM threads WHERE id=$1 AND kind='chat'`, [threadId]));
  const projects = await visibleProjects(ctx.pool, i.started_by, i.org_id);
  const cards = (await toDto(ctx, [i]))[0]?.cards ?? [];
  const org = await one(
    ctx.pool,
    `SELECT id FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`,
    [i.org_id],
  );
  return {
    intakeId: i.id,
    ...(fromChat ? { fromChat: true } : {}),
    ...(org ? { orgVaultId: org.id } : {}),
    ...(i.external_system ? { externalSystem: i.external_system as ExternalSystem } : {}),
    ...(i.external_key ? { externalKey: i.external_key } : {}),
    ...(i.project_key ? { mappedProjectKey: i.project_key } : {}),
    projects: projects.map((p) => ({ key: p.key, name: p.name, repos: p.repos })),
    cards: cards.map((c) => ({ ref: c.ref, title: c.title, status: c.status })),
  };
}

// --------------------------------------------------------------------------------------------- start

/**
 * The manager opens an intake: a chat with the BA about a ticket (docs/ARCHITECTURE.md section 16.5). Inbound is
 * read-only; the BA reads the ticket in the chat (Jira skill, `gh`). Needs a BA whose workstation is online: like any
 * chat, nothing is queued silently.
 */
export async function startIntake(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  req: CreateIntakeRequest,
): Promise<IntakeDto> {
  if (!isOrgManager({ orgRole: org.role }))
    throw forbidden('only the organization Owner and Admins can start an intake');
  return startIntakeIn(ctx, user, org.id, req);
}

/**
 * The intake itself, without the role check: a schedule that polls GitHub or Jira for new issues (its creator was
 * authorized when the schedule was made) starts one per issue.
 */
export async function startIntakeIn(
  ctx: Ctx,
  user: Pick<AuthSession['user'], 'id'>,
  orgId: string,
  req: CreateIntakeRequest,
): Promise<IntakeDto> {
  const org = { id: orgId };
  const ref = parseExternalRef(req.externalKey ?? req.note);
  const externalKey = req.externalKey ?? ref?.key;
  const externalSystem = req.externalSystem ?? ref?.system;
  const bas = await rows(
    ctx.pool,
    `SELECT a.id, a.workstation_id FROM agents a JOIN workstations ws ON ws.id = a.workstation_id
      WHERE a.org_id = $1 AND a.role_key = $2 AND a.status = 'active' AND ws.status = 'active'
      ORDER BY a.hired_at, a.id`,
    [org.id, BA_ROLE_KEY],
  );
  if (bas.length === 0)
    throw conflict('no_ba', 'Hire a business analyst (BA) first: intake is a conversation with the BA.');
  const ba = bas.find((a) => ctx.services.runners.isOnline(a.workstation_id));
  if (!ba)
    throw conflict(
      'ba_offline',
      "The BA's workstation is offline, so the conversation cannot start (nothing is queued).",
    );
  const intakeId = randomUUID();
  const threadId = randomUUID();
  await ctx.store.append([
    {
      streamId: streamId.intake(intakeId),
      event: {
        type: 'IntakeStarted',
        payload: {
          intakeId,
          threadId,
          ...(externalSystem ? { externalSystem } : {}),
          ...(externalKey ? { externalKey } : {}),
          startedBy: user.id,
          baAgentId: ba.id,
          note: req.note,
        },
      },
      actor: userActor(user.id),
      scope: orgScope(org.id),
    },
  ]);
  await ctx.services.chat.send(user.id, { threadId, body: req.note, clientMsgId: randomUUID() });
  return getIntake(ctx, org.id, intakeId);
}

// ------------------------------------------------------------------------------------ chat-scoped rpcs

const errorText = (err: unknown): string =>
  err instanceof HttpError
    ? `${err.message}${
        err.details && typeof err.details === 'object' && 'missing' in err.details
          ? ` (missing: ${(err.details as { missing: string[] }).missing.join(', ')})`
          : ''
      }`
    : err instanceof Error
      ? err.message
      : String(err);

const zodText = (issues: Array<{ path: PropertyKey[]; message: string }>): string =>
  issues.map((i) => `${i.path.join('.') || 'draft'}: ${i.message}`).join('; ');

const threadNote = (intake: Row, body: string): AppendInput => ({
  streamId: streamId.thread(intake.thread_id),
  event: {
    type: 'ThreadMessagePosted',
    payload: {
      threadId: intake.thread_id,
      messageId: randomUUID(),
      authorKind: 'system',
      kind: 'system',
      body,
      data: { intakeId: intake.id },
    },
  },
  actor: SYSTEM_ACTOR,
  scope: orgScope(intake.org_id),
});

/** Repo of a project by id or name. */
async function resolveRepo(tx: Queryable, projectId: string, repo: string): Promise<string> {
  const list = await rows<{ id: string; name: string }>(
    tx,
    'SELECT id, name FROM project_repos WHERE project_id=$1 AND removed_at IS NULL',
    [projectId],
  );
  const hit = list.find((r) => r.id === repo || r.name.toLowerCase() === repo.toLowerCase());
  if (!hit)
    throw new Error(
      `unknown repo '${repo}' (this project has: ${list.map((r) => r.name).join(', ') || 'none'})`,
    );
  return hit.id;
}

async function resolveDependencies(tx: Queryable, projectId: string, refs: string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const found = await rows<{ id: string; ref: string }>(
    tx,
    'SELECT id, ref FROM cards WHERE project_id=$1 AND ref = ANY($2::text[])',
    [projectId, refs.map((r) => r.toUpperCase())],
  );
  const missing = refs.filter((r) => !found.some((f) => f.ref === r.toUpperCase()));
  if (missing.length) throw new Error(`unknown dependency card(s): ${missing.join(', ')}`);
  return found.map((f) => f.id);
}

/** A dependency cycle through `cardId` (the BA edits drafts, so two drafts could wait on each other). */
export async function dependencyCycle(tx: Queryable, cardId: string): Promise<string[] | null> {
  const edges = await rows<{ card_id: string; depends_on_card_id: string }>(
    tx,
    `WITH RECURSIVE walk(card_id, depends_on_card_id) AS (
       SELECT card_id, depends_on_card_id FROM card_dependencies WHERE card_id = $1
       UNION
       SELECT d.card_id, d.depends_on_card_id FROM card_dependencies d JOIN walk w ON d.card_id = w.depends_on_card_id)
     SELECT card_id, depends_on_card_id FROM walk`,
    [cardId],
  );
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.card_id, [...(next.get(e.card_id) ?? []), e.depends_on_card_id]);
  const seen = new Set<string>();
  const stack = [...(next.get(cardId) ?? [])];
  while (stack.length) {
    const c = stack.pop() as string;
    if (c === cardId) return [...seen];
    if (seen.has(c)) continue;
    seen.add(c);
    stack.push(...(next.get(c) ?? []));
  }
  return null;
}

async function missingFor(tx: Queryable, cardId: string): Promise<string[]> {
  const card = await one(tx, 'SELECT * FROM cards WHERE id=$1', [cardId]);
  const wf = card ? await loadWorkflowById(tx, card.workflow_version_id) : undefined;
  return card && wf ? requiredMissing(cardView(card), specifyTarget(wf.definition).stage) : [];
}

export interface Responder {
  intake: Row;
  agent: Row;
}

/** The intake a BA chat belongs to (the chat's shift id -> its thread -> the intake). Null when it is none. */
async function intakeOf(ctx: Ctx, shift: Row): Promise<Responder | null> {
  const threadId = ctx.services.chat.threadOfChat(shift.id);
  if (!threadId) return null;
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [shift.agent_id]);
  if (!agent) return null;
  const find = () => one(ctx.pool, 'SELECT * FROM intakes WHERE thread_id=$1', [threadId]);
  let intake = await find();
  // The BA in any other chat with its manager: the chat becomes an intake without a ticket (lazily, on first use).
  if (!intake && agent.role_key === BA_ROLE_KEY) {
    const userId = ctx.services.chat.userOfChat(shift.id);
    if (userId) {
      try {
        intake = await startChatIntake(ctx, threadId, agent, userId);
      } catch (err) {
        intake = await find(); // a concurrent verb created it first
        if (!intake) throw err;
      }
    }
  }
  if (!intake || intake.ba_agent_id !== agent.id) return null;
  return { intake, agent };
}

/**
 * Turns a BA chat that was not started as an intake into one with no external ticket (docs/SPEC.md: chat "is how
 * intake ... happen[s]", every conversation "linked to any card or request it creates"). The intake belongs to the
 * chatting user, so every right is theirs; a project in the chat's context is mapped straight away.
 */
async function startChatIntake(
  ctx: Ctx,
  threadId: string,
  agent: Row,
  userId: string,
): Promise<Row | undefined> {
  const thread = await one(ctx.pool, `SELECT * FROM threads WHERE id=$1 AND kind='chat' AND created_by=$2`, [
    threadId,
    userId,
  ]);
  if (!thread || thread.agent_id !== agent.id) return undefined;
  const intakeId = randomUUID();
  const scope = orgScope(thread.org_id);
  const events: AppendInput[] = [
    {
      streamId: streamId.intake(intakeId),
      event: {
        type: 'IntakeStarted',
        payload: { intakeId, threadId, startedBy: userId, baAgentId: agent.id, source: 'chat' },
      },
      actor: userActor(userId),
      scope,
    },
  ];
  if (thread.project_id) {
    const project = (await visibleProjects(ctx.pool, userId, thread.org_id)).find(
      (p) => p.id === thread.project_id,
    );
    if (project)
      events.push({
        streamId: streamId.intake(intakeId),
        event: {
          type: 'TicketMapped',
          payload: { intakeId, projectId: project.id, unmapped: false },
        },
        actor: agentActor(agent.id),
        scope,
      });
  }
  await ctx.store.append(events);
  return one(ctx.pool, 'SELECT * FROM intakes WHERE id=$1', [intakeId]);
}

/**
 * `intake.map`, `intake.unmapped`, `card.create`, `card.update`, `card.specify`: what the BA does in its intake chat
 * (docs/PLAN.md M7). Cards are created for the manager who opened the intake (owner), with origin `intake`; a card is
 * validated against the field set on create and against the stage's required fields before `CardSpecified`.
 */
export async function intakeRpc(
  ctx: Ctx,
  shift: Row,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const who = await intakeOf(ctx, shift);
  if (!who)
    return [
      false,
      undefined,
      'only the BA can do this, in a chat with its manager (an intake or any other chat)',
    ];
  try {
    switch (method) {
      case 'intake.map':
        return await mapTicket(ctx, who, params);
      case 'intake.unmapped':
        return await askMapping(ctx, who, params);
      case 'card.create':
        return await createDraft(ctx, who, params);
      case 'card.update':
        return await updateDraft(ctx, who, params);
      case 'card.specify':
        return await specifyDraft(ctx, who, params);
      case 'phase.list':
      case 'phase.propose':
      case 'phase.assign':
      case 'phase.submit':
        return await phaseChatRpc(ctx, who, method, params);
      default:
        return [false, undefined, `${method} is not available`];
    }
  } catch (err) {
    return [false, undefined, errorText(err)];
  }
}

async function mapTicket(
  ctx: Ctx,
  { intake, agent }: Responder,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const p = IntakeMapParamsSchema.safeParse(params);
  if (!p.success) return [false, undefined, 'usage: aom intake map --project <KEY>'];
  const open = intake.mapping_desk_item_id
    ? await one(ctx.pool, `SELECT 1 FROM desk_items WHERE id=$1 AND status='open'`, [
        intake.mapping_desk_item_id,
      ])
    : undefined;
  if (open)
    return [
      false,
      undefined,
      'The manager was asked which project this belongs to on the desk; wait for the answer.',
    ];
  const projects = await visibleProjects(ctx.pool, intake.started_by, intake.org_id);
  const project = projects.find((x) => x.key === p.data.project.toUpperCase());
  if (!project)
    return [
      false,
      undefined,
      `unknown project '${p.data.project}' (projects: ${projects.map((x) => x.key).join(', ') || 'none'})`,
    ];
  await ctx.store.append([
    {
      streamId: streamId.intake(intake.id),
      event: {
        type: 'TicketMapped',
        payload: { intakeId: intake.id, projectId: project.id, unmapped: false },
      },
      actor: agentActor(agent.id),
      scope: orgScope(intake.org_id),
    },
    threadNote(
      intake,
      `${agent.name} mapped ${intake.external_key ?? 'the request'} to project ${project.key} (${project.name}).`,
    ),
  ]);
  return [true, { project: project.key, repos: project.repos }];
}

/** An unmapped ticket becomes a desk question: the manager picks the project (docs/SPEC.md "Operating model"). */
async function askMapping(
  ctx: Ctx,
  { intake, agent }: Responder,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const p = IntakeUnmappedParamsSchema.safeParse(params);
  if (!p.success) return [false, undefined, 'usage: aom intake unmapped --note "<why no project fits>"'];
  if (intake.mapped_project_id) return [false, undefined, 'the ticket is already mapped to a project'];
  const open = intake.mapping_desk_item_id
    ? await one(ctx.pool, `SELECT 1 FROM desk_items WHERE id=$1 AND status='open'`, [
        intake.mapping_desk_item_id,
      ])
    : undefined;
  if (open) return [false, undefined, 'the manager was already asked; wait for the answer'];
  const projects = await visibleProjects(ctx.pool, intake.started_by, intake.org_id);
  const title = `Which project does ${intake.external_key ?? 'this request'} belong to?`;
  const deskItemId = randomUUID();
  const matches = await dedupMatches(ctx.pool, intake.org_id, null, `${intake.external_key ?? ''} ${title}`);
  await ctx.store.append([
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'QuestionRaised',
        payload: {
          deskItemId,
          askedBy: { kind: 'agent', agentId: agent.id, role: agent.role_key },
          doing: p.data.note,
          question: title,
          options: projects.map((x) => ({ id: x.id, label: `${x.key}: ${x.name}` })),
          blocking: false,
          routedTo: 'manager',
          chainLevel: 'desk',
          dedupLedgerIds: matches.map((m) => m.id),
          affectedCardIds: [],
          pinned: false,
          subkind: UNMAPPED_TICKET_SUBKIND,
        },
      },
      actor: agentActor(agent.id),
      scope: orgScope(intake.org_id),
    },
    {
      streamId: streamId.intake(intake.id),
      event: { type: 'TicketMapped', payload: { intakeId: intake.id, unmapped: true, deskItemId } },
      actor: agentActor(agent.id),
      scope: orgScope(intake.org_id),
    },
    threadNote(
      intake,
      `${agent.name} could not map ${intake.external_key ?? 'the request'} to a project and asked on the desk: ${p.data.note}`,
    ),
  ]);
  return [
    true,
    {
      deskItemId,
      message:
        'Asked the manager which project this belongs to. Tell the manager so; you will be told the answer in this conversation. Do not create cards until then.',
    },
  ];
}

async function createDraft(
  ctx: Ctx,
  { intake, agent }: Responder,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const p = CardDraftSchema.safeParse(params);
  if (!p.success) return [false, undefined, `invalid card draft: ${zodText(p.error.issues)}`];
  if (!intake.mapped_project_id)
    return [
      false,
      undefined,
      'map the ticket to a project first (`aom intake map`, or `aom intake unmapped` to ask the manager)',
    ];
  const draft: CardDraft = p.data;
  const project = await one(ctx.pool, 'SELECT * FROM projects WHERE id=$1', [intake.mapped_project_id]);
  if (!project) return [false, undefined, 'the mapped project is gone'];
  if (draft.project && draft.project.toUpperCase() !== project.key)
    return [false, undefined, `this intake is mapped to ${project.key}, not ${draft.project}`];
  const result = await withAppendTx(ctx.pool, async (tx) => {
    const req: CreateCardRequest = {
      projectId: project.id,
      title: draft.title,
      cardType: draft.cardType,
      ...(draft.workflowKey ? { workflowKey: draft.workflowKey } : {}),
      fields: {
        ...draft.fields,
        externalRef: draft.externalRef ?? draft.fields.externalRef ?? intake.external_key ?? undefined,
      },
      ...(draft.repo ? { repoId: await resolveRepo(tx, project.id, draft.repo) } : {}),
      ...(draft.completionAction ? { completionAction: draft.completionAction } : {}),
      ...(draft.docsNeeded !== undefined ? { docsNeeded: draft.docsNeeded } : {}),
      ...(draft.priority !== undefined ? { priority: draft.priority } : {}),
      ...(draft.dependencies
        ? { dependencies: await resolveDependencies(tx, project.id, draft.dependencies) }
        : {}),
    };
    if (req.fields.externalRef === undefined) delete req.fields.externalRef;
    const created = await createCardIn(ctx, tx, pseudoUser(intake.started_by), req, {
      origin: 'intake',
      actor: agentActor(agent.id),
    });
    if (draft.riskTier)
      await patchCardIn(
        ctx,
        tx,
        pseudoUser(intake.started_by),
        created.cardId,
        { riskTier: draft.riskTier },
        {
          actor: agentActor(agent.id),
        },
      );
    if (draft.phase) await proposeCardPhaseIn(ctx, tx, { intake, agent }, created.cardId, draft.phase);
    const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [created.cardId])) as Row;
    await ctx.store.append(
      [
        {
          streamId: streamId.intake(intake.id),
          event: {
            type: 'TicketMapped',
            payload: { intakeId: intake.id, projectId: project.id, cardId: created.cardId, unmapped: false },
          },
          actor: agentActor(agent.id),
          scope: orgScope(intake.org_id),
        },
        cardMessage(
          card,
          { kind: 'agent', agentId: agent.id },
          'comment',
          `Drafted by ${agent.name} (BA) from the intake${intake.external_key ? ` of ${intake.external_key}` : ''}.`,
        ),
        threadNote(intake, `${agent.name} drafted ${created.ref}: ${draft.title}`),
      ],
      { tx },
    );
    return { ref: created.ref, id: created.cardId, missing: await missingFor(tx, created.cardId) };
  });
  return [true, result];
}

/** The card must be a draft this intake created. */
async function draftOf(tx: Queryable, intake: Row, ref: unknown): Promise<Row> {
  if (typeof ref !== 'string' || !ref) throw new Error('a card ref is required (for example TOY-3)');
  const card = await one(
    tx,
    `SELECT c.* FROM cards c JOIN intake_cards ic ON ic.card_id = c.id AND ic.intake_id = $1 WHERE c.ref = upper($2)`,
    [intake.id, ref],
  );
  if (!card) throw new Error(`${ref} is not a card of this intake`);
  if (card.status !== 'draft')
    throw new Error(`${card.ref} is already ${card.status}: only drafts can be changed here`);
  return card;
}

async function updateDraft(
  ctx: Ctx,
  { intake, agent }: Responder,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const { ref, ...rest } = params;
  const p = CardDraftPatchSchema.safeParse(rest);
  if (!p.success) return [false, undefined, `invalid card patch: ${zodText(p.error.issues)}`];
  const patch = p.data;
  const out = await withAppendTx(ctx.pool, async (tx) => {
    const card = await draftOf(tx, intake, ref);
    const changes: PatchCardRequest = {};
    if (patch.title !== undefined) changes.title = patch.title;
    if (patch.priority !== undefined) changes.priority = patch.priority;
    if (patch.docsNeeded !== undefined) changes.docsNeeded = patch.docsNeeded;
    if (patch.completionAction !== undefined) changes.completionAction = patch.completionAction;
    if (patch.riskTier !== undefined) changes.riskTier = patch.riskTier;
    if (patch.repo !== undefined) changes.repoId = await resolveRepo(tx, card.project_id, patch.repo);
    if (patch.dependencies !== undefined)
      changes.dependencies = await resolveDependencies(tx, card.project_id, patch.dependencies);
    const fields = { ...(patch.fields ?? {}) } as Record<string, unknown>;
    if (patch.externalRef !== undefined) fields.externalRef = patch.externalRef;
    if (Object.keys(fields).length > 0) changes.fields = fields;
    await patchCardIn(ctx, tx, pseudoUser(intake.started_by), card.id, changes, {
      actor: agentActor(agent.id),
    });
    // `phase: ""` takes the draft out of its phase.
    if (patch.phase !== undefined)
      await proposeCardPhaseIn(ctx, tx, { intake, agent }, card.id, patch.phase === '' ? null : patch.phase);
    return { ref: card.ref, missing: await missingFor(tx, card.id) };
  });
  return [true, out];
}

async function specifyDraft(
  ctx: Ctx,
  { intake, agent }: Responder,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const out = await withAppendTx(ctx.pool, async (tx) => {
    const card = await draftOf(tx, intake, params.ref);
    const cycle = await dependencyCycle(tx, card.id);
    if (cycle)
      throw new Error(`${card.ref} depends on itself through other cards: fix the dependency graph first`);
    // Schema validation happens inside: the card's fields and the build stage's required fields.
    await specifyCardIn(ctx, tx, pseudoUser(intake.started_by), card.id, { actor: agentActor(agent.id) });
    const after = (await one(tx, 'SELECT ref, stage, status FROM cards WHERE id=$1', [card.id])) as Row;
    await ctx.store.append(
      [
        threadNote(
          intake,
          `${agent.name} specified ${after.ref}: it is in ${after.stage} (${after.status}).`,
        ),
      ],
      { tx },
    );
    return { ref: after.ref, stage: after.stage, status: after.status };
  });
  return [true, out];
}

/** Events that map the intake once the manager answered its desk question (called inside the answer transaction). */
export async function mappingAnsweredEvents(
  tx: Tx,
  item: Row,
  user: { id: string },
  projectId: string,
): Promise<{ events: AppendInput[]; intake: Row; projectKey: string } | null> {
  const intake = await one(tx, 'SELECT * FROM intakes WHERE mapping_desk_item_id=$1', [item.id]);
  const project = await one(
    tx,
    `SELECT p.key, p.name FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = $2 AND m.status = 'active'
      WHERE p.id = $1 AND p.status = 'active' AND p.kind = 'project'`,
    [projectId, user.id],
  );
  if (!intake || !project) return null;
  return {
    intake,
    projectKey: project.key,
    events: [
      {
        streamId: streamId.intake(intake.id),
        event: { type: 'TicketMapped', payload: { intakeId: intake.id, projectId, unmapped: false } },
        actor: userActor(user.id),
        scope: orgScope(intake.org_id),
      },
      threadNote(
        intake,
        `The manager mapped ${intake.external_key ?? 'the request'} to project ${project.key} (${project.name}).`,
      ),
    ],
  };
}

/**
 * Tells the BA the manager's mapping answer so it carries on (the chat is one call per message). The BA may still be
 * finishing the turn in which it asked, so this waits (in the background) until the conversation is free.
 */
export function continueIntake(ctx: Ctx, intake: Row, projectKey: string): void {
  void (async () => {
    try {
      for (let i = 0; i < 240 && ctx.services.chat.isBusy(intake.thread_id); i++)
        await new Promise((r) => setTimeout(r, 500));
      await ctx.services.chat.send(intake.started_by, {
        threadId: intake.thread_id,
        body: `[Desk] I mapped ${intake.external_key ?? 'this request'} to project ${projectKey}. Continue the intake.`,
        clientMsgId: randomUUID(),
      });
    } catch (err) {
      ctx.log.warn({ err }, 'could not continue the intake chat');
    }
  })();
}
