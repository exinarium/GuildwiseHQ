import { randomUUID } from 'node:crypto';
import {
  type AddRepoRequest,
  type ConvertCardDecision,
  type ConvertCardDto,
  type ConvertPreview,
  type ConvertProjectRequest,
  type ConvertResult,
  canConvertProject,
  type PendingConversion,
  PROJECT_FILE,
  PROJECT_FILE_HEADER,
  RESEARCH_INDEX_SECTION_ID,
  type ResearchIndexNote,
  renderResearchIndex,
  streamId,
  workflowUsesRepos,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { resolveWorkflow } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput, StoredEvent } from '../eventstore/types.ts';
import { cancelCardIn } from './cards.ts';
import { projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { projectVault } from './decisions.ts';
import { repoAddedEvent } from './projects.ts';
import { repoCreateRequestEvents } from './repo-create.ts';
import { enqueueVaultWrite } from './vaults.ts';

/**
 * Conversion of a project to another workflow (docs/design/restructure.md section 8, owner decision 12: any to any).
 * Research is a stage: a research-first project converts to code (or a custom workflow) once its notes are in. The
 * Owner and Admins convert. Open cards the new workflow cannot place are kept (they finish on their own workflow and
 * show in extra board columns) or cancelled with the reason "Project converted". A new repository may be requested
 * (the same desk approval and runner flow as `aom repo create`); when nothing else supplies a repository the
 * conversion waits for it (`pending_conversion`) and completes when the repository exists.
 */

export const CONVERT_CANCEL_REASON = 'Project converted';

/** What the dialog shows as the usual next step from a workflow. */
const SUGGESTED_NEXT: Record<string, string> = { research: 'code' };

async function assertCanConvert(tx: Queryable, userId: string, project: Row): Promise<void> {
  if (!canConvertProject({ orgRole: await orgRoleOf(tx, userId, project.org_id) }))
    throw forbidden('only the organization Owner and Admins can convert a project');
  if (project.status !== 'active') throw conflict('project_archived', 'project is archived');
}

async function targetWorkflow(tx: Queryable, project: Row, toWorkflowKey: string) {
  const wf = await resolveWorkflow(tx, project.org_id, toWorkflowKey);
  if (!wf) throw badRequest('unknown_workflow', `workflow '${toWorkflowKey}' does not exist`);
  // `feed` belongs to interests and `code-bugfix` to the bug children of code cards: neither is a project workflow.
  if (wf.definition.fieldSet === 'feed' || toWorkflowKey === 'code-bugfix')
    throw badRequest('invalid_target', `a project cannot be converted to the ${toWorkflowKey} workflow`);
  if (toWorkflowKey === project.workflow_key)
    throw badRequest('same_workflow', 'the project already runs this workflow');
  return wf;
}

/** Open cards of the project that run on another workflow than `toWorkflowKey` (they need a decision). */
async function openCards(tx: Queryable, projectId: string, toWorkflowKey: string, lock = false) {
  const cards = await rows(
    tx,
    `SELECT c.*, wv.key AS wf_key FROM cards c JOIN workflow_versions wv ON wv.id = c.workflow_version_id
      WHERE c.project_id=$1 AND c.status NOT IN ('done','cancelled') ORDER BY c.number ${lock ? 'FOR UPDATE OF c' : ''}`,
    [projectId],
  );
  return {
    foreign: cards.filter((c) => c.wf_key !== toWorkflowKey),
    placed: cards.filter((c) => c.wf_key === toWorkflowKey),
  };
}

const cardDto = (c: Row): ConvertCardDto => ({
  id: c.id,
  ref: c.ref,
  title: c.title,
  cardType: c.card_type,
  workflowKey: c.wf_key,
  stage: c.stage,
  status: c.status,
  claimed: !!c.claim_id,
});

/** `GET /api/projects/:id/convert-preview`: what the dialog shows before the Owner confirms. */
export async function convertPreview(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  toWorkflowKey: string,
): Promise<ConvertPreview> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  await assertCanConvert(ctx.pool, user.id, p);
  const wf = await targetWorkflow(ctx.pool, p, toWorkflowKey);
  const { foreign, placed } = await openCards(ctx.pool, projectId, toWorkflowKey);
  const n = async (sql: string) => Number((await one(ctx.pool, sql, [projectId]))?.n ?? 0);
  return {
    fromWorkflowKey: p.workflow_key,
    toWorkflowKey,
    toWorkflowName: wf.definition.name,
    usesRepos: workflowUsesRepos(wf.definition),
    activeRepos: await n(
      'SELECT count(*) AS n FROM project_repos WHERE project_id=$1 AND removed_at IS NULL',
    ),
    publishedNotes: await n('SELECT count(*) AS n FROM research_publications WHERE project_id=$1'),
    foreignCards: foreign.map(cardDto),
    placedCards: placed.length,
    suggested: SUGGESTED_NEXT[p.workflow_key] ?? null,
  };
}

interface Decision {
  cardId: string;
  decision: ConvertCardDecision;
}

/**
 * Converts the project (or, when it needs a repository that has to be approved first, records the conversion and
 * waits). One transaction: the repositories added now, `ProjectConverted`, and for each decided card its cancellation.
 */
export async function convertProject(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: ConvertProjectRequest,
): Promise<ConvertResult> {
  const workstations = new Set<string>();
  const result = await withAppendTx(ctx.pool, async (tx): Promise<ConvertResult> => {
    const visible = await loadVisibleProject(tx, user.id, projectId);
    await assertCanConvert(tx, user.id, visible);
    // The project row is the lock for everything below (a second request waits and then sees the first one).
    const p = (await one(tx, 'SELECT * FROM projects WHERE id=$1 FOR UPDATE', [projectId])) as Row;
    if (p.pending_conversion)
      throw conflict(
        'conversion_pending',
        'a conversion of this project is waiting for its repositories: cancel it first',
      );
    const wf = await targetWorkflow(tx, p, req.toWorkflowKey);
    const { foreign } = await openCards(tx, projectId, req.toWorkflowKey, true);
    const known = new Set(foreign.map((c) => c.id as string));
    for (const id of Object.keys(req.cardDecisions))
      if (!known.has(id))
        throw badRequest('invalid_card', 'a decision names a card that is not an open card of this project');
    const decisions: Decision[] = foreign.map((c) => ({
      cardId: c.id as string,
      decision: req.cardDecisions[c.id as string] ?? req.defaultDecision,
    }));

    const adds = req.repos.filter((r): r is Extract<typeof r, { remoteUrl: string }> => 'remoteUrl' in r);
    const creates = req.repos.filter((r): r is Extract<typeof r, { create: unknown }> => 'create' in r);
    const activeRepos = Number(
      (
        await one(tx, 'SELECT count(*) AS n FROM project_repos WHERE project_id=$1 AND removed_at IS NULL', [
          projectId,
        ])
      )?.n ?? 0,
    );
    const needsRepos = workflowUsesRepos(wf.definition);
    const waiting = needsRepos && activeRepos + adds.length === 0;
    if (waiting && creates.length === 0)
      throw badRequest(
        'repo_required',
        `the ${wf.definition.name} workflow works in repositories: add one, or request a new one`,
      );

    const actor = userActor(user.id);
    const repoEvents: AppendInput[] = [];
    const repoIds: string[] = [];
    const seenUrls = new Set<string>();
    for (const a of adds) {
      const input: AddRepoRequest = { name: a.name, remoteUrl: a.remoteUrl, workingBranch: a.workingBranch };
      const { repoId, event } = await repoAddedEvent(ctx, tx, p, input, actor);
      const key = (event.event as { payload: { remoteUrlNormalized: string } }).payload.remoteUrlNormalized;
      if (seenUrls.has(key)) throw conflict('repo_exists', `${a.remoteUrl} is listed twice`);
      seenUrls.add(key);
      repoEvents.push(event);
      repoIds.push(repoId);
    }
    const requests: ConvertResult['repoRequests'] = [];
    const requestEvents: AppendInput[] = [];
    const seenNames = new Set<string>();
    for (const c of creates) {
      const spec = c.create;
      if (seenNames.has(spec.name.toLowerCase()))
        throw conflict('repo_request_exists', `${spec.name} is listed twice`);
      seenNames.add(spec.name.toLowerCase());
      const r = await repoCreateRequestEvents(
        tx,
        user,
        p,
        { name: spec.name, visibility: spec.visibility, description: spec.description },
        `to convert ${p.key} to ${wf.definition.name}`,
      );
      requestEvents.push(...r.events);
      requests.push({ requestId: r.requestId, name: spec.name, deskItemId: r.deskItemId });
    }

    const scope = projectScope(p.org_id, projectId);
    if (waiting) {
      await ctx.store.append(
        [
          ...requestEvents,
          {
            streamId: streamId.project(projectId),
            event: {
              type: 'ProjectConversionRequested',
              payload: {
                projectId,
                conversionId: randomUUID(),
                toWorkflowKey: req.toWorkflowKey,
                cardDecisions: decisions,
                repoRequestIds: requests.map((r) => r.requestId),
                ...(req.note ? { note: req.note } : {}),
                by: user.id,
              },
            },
            actor,
            scope,
          },
        ],
        { tx },
      );
      return { status: 'waiting', cancelledCards: 0, keptCards: 0, repoRequests: requests };
    }
    await ctx.store.append([...repoEvents, ...requestEvents], { tx });
    const { cancelled } = await finishConversionIn(ctx, tx, user, p, {
      toWorkflowKey: req.toWorkflowKey,
      decisions,
      repoIds,
      note: req.note,
      workstations,
    });
    return {
      status: 'converted',
      cancelledCards: cancelled,
      keptCards: decisions.length - cancelled,
      repoRequests: requests,
    };
  });
  for (const ws of workstations) await ctx.services.gateway.deliverPending(ws);
  return result;
}

/** Appends `ProjectConverted` and cancels the cards decided "cancel". Shared by the direct and the waiting path. */
async function finishConversionIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string; displayName: string },
  project: Row,
  plan: {
    toWorkflowKey: string;
    decisions: Decision[];
    repoIds: string[];
    note?: string | undefined;
    workstations: Set<string>;
  },
): Promise<{ cancelled: number }> {
  const open = await rows(
    tx,
    `SELECT * FROM cards WHERE id = ANY($1::uuid[]) AND status NOT IN ('done','cancelled') ORDER BY number FOR UPDATE`,
    [plan.decisions.map((d) => d.cardId)],
  );
  const openIds = new Set(open.map((c) => c.id as string));
  const decisions = plan.decisions.filter((d) => openIds.has(d.cardId));
  const cancelIds = new Set(decisions.filter((d) => d.decision === 'cancel').map((d) => d.cardId));
  await ctx.store.append(
    [
      {
        streamId: streamId.project(project.id),
        event: {
          type: 'ProjectConverted',
          payload: {
            projectId: project.id,
            fromWorkflowKey: project.workflow_key,
            toWorkflowKey: plan.toWorkflowKey,
            cardDecisions: decisions,
            cancelledCardIds: [...cancelIds],
            repoIds: plan.repoIds,
            ...(plan.note ? { note: plan.note } : {}),
            by: user.id,
          },
        },
        actor: userActor(user.id),
        scope: projectScope(project.org_id, project.id),
      },
    ],
    { tx },
  );
  for (const card of open) {
    if (!cancelIds.has(card.id)) continue;
    const ws = await cancelCardIn(ctx, tx, user, card, CONVERT_CANCEL_REASON, {
      cause: 'project_converted',
      alsoCancelling: cancelIds,
    });
    if (ws) plan.workstations.add(ws);
  }
  return { cancelled: cancelIds.size };
}

// ----------------------------------------------------------------------------- waiting conversions

/**
 * Called inside the transaction of a repository request's outcome (approval result, rejection): when every request of
 * the waiting conversion has been answered the project converts (at least one repository was created) or the
 * conversion is cancelled (all were declined). A request still pending, approved or failed keeps it waiting.
 */
export async function settleConversionIn(ctx: Ctx, tx: Tx, projectId: string): Promise<void> {
  const p = await one(tx, 'SELECT * FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
  const pc = p?.pending_conversion as
    | {
        conversionId: string;
        toWorkflowKey: string;
        cardDecisions: Decision[];
        repoRequestIds: string[];
        note?: string;
        by: string;
      }
    | null
    | undefined;
  if (!p || !pc) return;
  const reqs = await rows(tx, 'SELECT * FROM repo_requests WHERE id = ANY($1::uuid[])', [pc.repoRequestIds]);
  if (reqs.some((r) => ['pending', 'approved', 'failed'].includes(r.status))) return;
  const created = reqs.filter((r) => r.status === 'created');
  const scope = projectScope(p.org_id, p.id);
  if (created.length === 0) {
    await ctx.store.append(
      [
        {
          streamId: streamId.project(p.id),
          event: {
            type: 'ProjectConversionCancelled',
            payload: {
              projectId: p.id,
              conversionId: pc.conversionId,
              reason: 'every repository request was declined',
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
      ],
      { tx },
    );
    return;
  }
  const by = await one(tx, 'SELECT id, display_name FROM users WHERE id=$1', [pc.by]);
  const workstations = new Set<string>();
  await finishConversionIn(ctx, tx, { id: pc.by, displayName: by?.display_name ?? 'The owner' }, p, {
    toWorkflowKey: pc.toWorkflowKey,
    decisions: pc.cardDecisions,
    repoIds: created.map((r) => r.project_repo_id as string).filter(Boolean),
    note: pc.note,
    workstations,
  });
  // Queued worktree removals (cancelled cards) are delivered with the runner's next pending-command pass.
}

/**
 * The events that end a waiting conversion: its still-pending repository requests are declined (their desk items
 * dismissed) and `ProjectConversionCancelled` follows. Empty when the project has no waiting conversion.
 */
export async function cancelConversionEvents(
  tx: Queryable,
  project: Row,
  by: string,
  why: string,
  /** False when the caller dismisses the project's open desk items itself (archiving). */
  dismissDesk = true,
): Promise<AppendInput[]> {
  const pc = project.pending_conversion as { conversionId: string; repoRequestIds: string[] } | null;
  if (!pc) return [];
  const scope = projectScope(project.org_id, project.id);
  const actor = userActor(by);
  const events: AppendInput[] = [];
  for (const r of await rows(
    tx,
    `SELECT * FROM repo_requests WHERE id = ANY($1::uuid[]) AND status = 'pending' FOR UPDATE`,
    [pc.repoRequestIds],
  )) {
    events.push({
      streamId: streamId.repo(r.id),
      event: { type: 'RepoCreateRejected', payload: { requestId: r.id, by, reason: why } },
      actor,
      scope,
    });
    if (dismissDesk)
      events.push({
        streamId: streamId.desk(r.desk_item_id),
        event: {
          type: 'DeskItemResolved',
          payload: {
            deskItemId: r.desk_item_id,
            resolution: 'dismissed',
            note: why,
            by: { kind: 'user', userId: by },
          },
        },
        actor,
        scope,
      });
  }
  events.push({
    streamId: streamId.project(project.id),
    event: {
      type: 'ProjectConversionCancelled',
      payload: { projectId: project.id, conversionId: pc.conversionId, by, reason: why },
    },
    actor,
    scope,
  });
  return events;
}

/** Cancels a waiting conversion (Owner or Admin). */
export async function cancelConversion(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const visible = await loadVisibleProject(tx, user.id, projectId);
    await assertCanConvert(tx, user.id, visible);
    const p = (await one(tx, 'SELECT * FROM projects WHERE id=$1 FOR UPDATE', [projectId])) as Row;
    if (!p.pending_conversion) throw notFound('this project has no waiting conversion');
    await ctx.store.append(await cancelConversionEvents(tx, p, user.id, 'The conversion was cancelled.'), {
      tx,
    });
  });
}

/** The waiting conversion of a project with the state of each repository request (for the dialog and the settings). */
export async function pendingConversionOf(db: Queryable, project: Row): Promise<PendingConversion | null> {
  const pc = project.pending_conversion as {
    conversionId: string;
    toWorkflowKey: string;
    repoRequestIds: string[];
  } | null;
  if (!pc) return null;
  const reqs = await rows(
    db,
    'SELECT id, name, status, desk_item_id, error FROM repo_requests WHERE id = ANY($1::uuid[]) ORDER BY created_at',
    [pc.repoRequestIds],
  );
  return {
    conversionId: pc.conversionId,
    toWorkflowKey: pc.toWorkflowKey,
    requests: reqs.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      deskItemId: r.desk_item_id,
      error: r.error ?? null,
    })),
  };
}

// ----------------------------------------------------------------------------- PROJECT.md

/** The published notes of a project as the research index lists them. */
export async function researchIndexNotes(db: Queryable, projectId: string): Promise<ResearchIndexNote[]> {
  const list = await rows(
    db,
    `SELECT r.vault_path, r.title, r.citations, r.created_at, c.ref FROM research_publications r
       JOIN cards c ON c.id = r.card_id WHERE r.project_id=$1 ORDER BY r.event_seq`,
    [projectId],
  );
  return list.map((r) => ({
    title: r.title,
    vaultPath: r.vault_path,
    cardRef: r.ref,
    citations: Array.isArray(r.citations) ? r.citations.length : 0,
    publishedAt: iso(r.created_at) as string,
  }));
}

/**
 * After a conversion committed: lists the research notes in `PROJECT.md` of the project's vault folder, in the managed
 * `research-index` section (the runner writes the vault; a section with an older or equal version is a no-op, so a
 * replay never writes twice). Every later shift reads `PROJECT.md`, so the research reaches the builders. No vault
 * registered, or no notes: nothing is written.
 */
export async function writeResearchIndex(ctx: Ctx, e: StoredEvent): Promise<void> {
  if (e.event.type !== 'ProjectConverted') return;
  const p = e.event.payload;
  const notes = await researchIndexNotes(ctx.pool, p.projectId);
  if (notes.length === 0) return;
  const target = await projectVault(ctx.pool, p.projectId);
  if (!target?.vaultId) return;
  const to = await one(
    ctx.pool,
    'SELECT name FROM workflow_versions WHERE key=$1 ORDER BY version DESC LIMIT 1',
    [p.toWorkflowKey],
  );
  const r = await enqueueVaultWrite(ctx, ctx.pool, target.vaultId, {
    path: `${target.folder}/${PROJECT_FILE}`,
    mode: 'section',
    section: { id: RESEARCH_INDEX_SECTION_ID, version: Number(e.seq) },
    content: renderResearchIndex(notes, {
      folder: target.folder,
      convertedTo: to?.name ?? p.toWorkflowKey,
    }),
    header: PROJECT_FILE_HEADER,
    commitMessage: 'list the research notes in PROJECT.md',
  });
  if (r.queued && r.workstationId) await ctx.services.gateway.deliverPending(r.workstationId);
}
