import { randomUUID } from 'node:crypto';
import {
  BA_ROLE_KEY,
  DESK_SUBKIND,
  FORGE_LABELS,
  isOrgManager,
  isResearchStage,
  normalizeRemoteUrl,
  RepoCreateParamsSchema,
  type RepoCreatePayload,
  RepoCreateResultSchema,
  type RepoProvider,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { agentActor, orgScope, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { settleConversionIn } from './convert.ts';
import { addRepoIn } from './projects.ts';

/**
 * Approved repository setup (docs/SPEC.md "External systems boundary"). Agents cannot create repositories: the sandbox
 * has no GitHub credentials and `git push` is denied. The BA (in any chat) or the DevOps engineer asks with
 * `aom repo create`; the request lands on the project owner's desk; on approval the server queues `repo.create` for the
 * owner's own connected workstation, whose runner creates the repository with the owner's local `gh` login, pushes the
 * first commit, clones it under a repo root and reports the URL. The server then adds it to the project.
 */

type RpcReply = [boolean, unknown?, string?];

/** The repository name inside a `owner/repo`, `group/sub/project` or `org/project/repo` full name. */
const lastSegment = (fullName: string): string => String(fullName).split('/').pop() as string;

const approvalText = (provider: RepoProvider, projectKey: string): string => {
  const how =
    provider === 'github'
      ? 'with your own GitHub login on that workstation (gh)'
      : `on ${FORGE_LABELS[provider]} with the login you saved on that workstation (Connect git hosts)`;
  return `Approving creates this repository ${how}, pushes a first commit (README.md) to main, clones it next to your other repositories and adds it to project ${projectKey}. Nothing is created until you approve.`;
};
const LIVE = ['pending', 'approved', 'created'];

const issuesText = (issues: Array<{ path: PropertyKey[]; message: string }>): string =>
  issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ');

/** A system note on the chat or DevOps thread the request came from: the agent sees it with its next message. */
async function threadNote(
  db: Queryable,
  threadId: string | null,
  body: string,
  data: object,
): Promise<AppendInput[]> {
  if (!threadId) return [];
  const t = await one(db, 'SELECT org_id FROM threads WHERE id=$1', [threadId]);
  if (!t) return [];
  return [
    {
      streamId: streamId.thread(threadId),
      event: {
        type: 'ThreadMessagePosted',
        payload: {
          threadId,
          messageId: randomUUID(),
          authorKind: 'system',
          kind: 'system',
          body,
          data: data as Record<string, unknown>,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(t.org_id),
    },
  ];
}

/** The connected workstation of the user (the owner's runner holds their `gh` login), most recently seen first. */
async function connectedWorkstation(db: Queryable, userId: string): Promise<Row | undefined> {
  return one(
    db,
    `SELECT id, name FROM workstations WHERE user_id=$1 AND status='active' AND connected
      ORDER BY last_seen_at DESC NULLS LAST, paired_at LIMIT 1`,
    [userId],
  );
}

/** A connected workstation of the organization's Owner or an Admin: the repository is created with that person's GitHub login. */
async function managerWorkstation(db: Queryable, orgId: string): Promise<Row | undefined> {
  return one(
    db,
    `SELECT w.id, w.name FROM workstations w JOIN org_members om ON om.user_id = w.user_id
      WHERE om.org_id=$1 AND om.status='active' AND om.role IN ('owner','admin')
        AND w.status='active' AND w.connected
      ORDER BY w.last_seen_at DESC NULLS LAST, w.paired_at LIMIT 1`,
    [orgId],
  );
}

/** `aom repo create` from a chat with the BA or the DevOps engineer, or from a DevOps shift. */
export async function repoCreateRpc(
  ctx: Ctx,
  shift: Row,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const p = RepoCreateParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      `invalid request: ${issuesText(p.error.issues)}. usage: aom repo create [--provider github|gitlab|azure-devops|bitbucket-cloud] --name <owner/repo | group/project | org/project/repo | workspace/repo> --private|--public --project <KEY> [--description "<text>"]`,
    ];
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [shift.agent_id]);
  if (!agent) return [false, undefined, 'unknown agent'];
  let userId: string | undefined;
  let threadId: string | null = null;
  if (shift.kind === 'chat' && (agent.role_key === BA_ROLE_KEY || agent.is_devops)) {
    userId = ctx.services.chat.userOfChat(shift.id);
    threadId = ctx.services.chat.threadOfChat(shift.id) ?? null;
  } else if (shift.kind === 'devops' && agent.is_devops) {
    const req = await one(
      ctx.pool,
      `SELECT r.org_id, r.thread_id, w.user_id FROM devops_requests r JOIN workstations w ON w.id = r.workstation_id
        WHERE r.shift_id=$1`,
      [shift.id],
    );
    userId = req?.user_id;
    threadId = req?.thread_id ?? null;
  } else
    return [
      false,
      undefined,
      'only the BA and the DevOps engineer (in a chat with their manager, or a DevOps request) can request a repository',
    ];
  if (!userId) return [false, undefined, 'this conversation has no manager to ask'];

  const project = await one(
    ctx.pool,
    `SELECT p.id, p.key, p.name, p.org_id, p.workflow_key FROM projects p
       JOIN project_members m ON m.project_id = p.id AND m.user_id = $1 AND m.status = 'active'
      WHERE p.key = $2 AND p.status = 'active'`,
    [userId, p.data.project.toUpperCase()],
  );
  if (!project)
    return [false, undefined, `unknown project '${p.data.project}' (use a project key you may work in)`];
  if (isResearchStage(project.workflow_key))
    return [
      false,
      undefined,
      `project ${project.key} is still in the research stage: repositories come with the conversion to a delivery project. Ask the manager to convert it.`,
    ];
  if (!(await managerWorkstation(ctx.pool, project.org_id)))
    return [
      false,
      undefined,
      "the project owner has no connected workstation: the repository is created with the owner's GitHub login there. Ask them to start their runner",
    ];

  const live = () =>
    one(
      ctx.pool,
      `SELECT r.*, pr.key AS project_key FROM repo_requests r JOIN projects pr ON pr.id = r.project_id
        WHERE r.project_id=$1 AND lower(r.name)=lower($2) AND r.status = ANY($3)`,
      [project.id, p.data.name, LIVE],
    );
  const already = (r: Row): RpcReply => [
    true,
    {
      requestId: r.id,
      status: r.status,
      duplicate: true,
      ...(r.remote_url ? { remoteUrl: r.remote_url } : {}),
      message:
        r.status === 'created'
          ? `${r.name} was already created and added to project ${r.project_key}; use it as repo '${lastSegment(r.name)}'.`
          : `A request for ${r.name} is already waiting for the project owner's approval on the desk. Tell the manager; do not ask again.`,
    },
  ];
  const dup = await live();
  if (dup) return already(dup);

  const requestId = randomUUID();
  const deskItemId = randomUUID();
  const ws = await managerWorkstation(ctx.pool, project.org_id);
  const body = [
    `Repository: ${p.data.name}`,
    `Git host: ${FORGE_LABELS[p.data.provider]}${p.data.host ? ` (${p.data.host})` : ''}`,
    `Visibility: ${p.data.visibility}`,
    `Project: ${project.key} (${project.name})`,
    ...(p.data.description ? [`Description: ${p.data.description}`] : []),
    `Requested by: ${agent.name}`,
    `Runs on: ${ws?.name ?? 'your connected workstation'} (your workstation)`,
    '',
    approvalText(p.data.provider, project.key),
  ].join('\n');
  const scope = projectScope(project.org_id, project.id);
  try {
    await withAppendTx(ctx.pool, async (tx) => {
      await ctx.store.append(
        [
          {
            streamId: streamId.desk(deskItemId),
            event: {
              type: 'DeskItemCreated',
              payload: {
                deskItemId,
                kind: 'approval',
                subkind: DESK_SUBKIND.repoCreate,
                title: `Create repository ${p.data.name}`,
                body,
                options: [],
                blocking: false,
                pinned: false,
                projectId: project.id,
                affectedCardIds: [],
                askedBy: { kind: 'agent', agentId: agent.id },
              },
            },
            actor: agentActor(agent.id),
            scope,
          },
          {
            streamId: streamId.repo(requestId),
            event: {
              type: 'RepoCreateRequested',
              payload: {
                requestId,
                projectId: project.id,
                name: p.data.name,
                visibility: p.data.visibility,
                ...(p.data.description ? { description: p.data.description } : {}),
                ...(p.data.provider !== 'github' ? { provider: p.data.provider } : {}),
                ...(p.data.host ? { host: p.data.host } : {}),
                requestedByAgentId: agent.id,
                ...(threadId ? { threadId } : {}),
                deskItemId,
              },
            },
            actor: agentActor(agent.id),
            scope,
          },
          ...(await threadNote(
            tx,
            threadId,
            `${agent.name} asked the project owner to create repository ${p.data.name} for ${project.key}. Nothing is created until they approve it on the desk.`,
            { repoRequestId: requestId },
          )),
        ],
        { tx },
      );
    });
  } catch (err) {
    const raced = await live(); // a concurrent identical request won the unique index
    if (raced) return already(raced);
    throw err;
  }
  return [
    true,
    {
      requestId,
      status: 'pending',
      message: `Asked the project owner to approve creating ${p.data.name} on the desk. Tell the manager; once approved the repository is added to project ${project.key} and you will see it in the conversation.`,
    },
  ];
}

/**
 * A new repository asked for from the project's convert dialog (restructure.md decision 7): the same request, desk
 * approval and runner flow as `aom repo create`, asked by the manager instead of an agent. Returns the events and ids;
 * the caller appends them in its own transaction. 409 when a live request for the same name exists.
 */
export async function repoCreateRequestEvents(
  tx: Tx,
  user: { id: string; displayName?: string },
  project: Row,
  spec: { name: string; visibility: 'private' | 'public'; description?: string },
  context: string,
): Promise<{ events: AppendInput[]; requestId: string; deskItemId: string }> {
  const live = await one(
    tx,
    `SELECT 1 FROM repo_requests WHERE project_id=$1 AND lower(name)=lower($2) AND status = ANY($3)`,
    [project.id, spec.name, LIVE],
  );
  if (live)
    throw conflict('repo_request_exists', `a request for ${spec.name} already exists for this project`);
  const requestId = randomUUID();
  const deskItemId = randomUUID();
  const ws = await managerWorkstation(tx, project.org_id);
  const body = [
    `Repository: ${spec.name}`,
    `Visibility: ${spec.visibility}`,
    `Project: ${project.key} (${project.name})`,
    ...(spec.description ? [`Description: ${spec.description}`] : []),
    `Requested by: ${user.displayName ?? 'a manager'}, ${context}`,
    `Runs on: ${ws?.name ?? 'your connected workstation'} (your workstation)`,
    '',
    approvalText('github', project.key),
  ].join('\n');
  const scope = projectScope(project.org_id, project.id);
  const actor = userActor(user.id);
  return {
    requestId,
    deskItemId,
    events: [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'approval',
            subkind: DESK_SUBKIND.repoCreate,
            title: `Create repository ${spec.name}`,
            body,
            options: [],
            blocking: false,
            pinned: false,
            projectId: project.id,
            affectedCardIds: [],
            askedBy: { kind: 'user', userId: user.id },
          },
        },
        actor,
        scope,
      },
      {
        streamId: streamId.repo(requestId),
        event: {
          type: 'RepoCreateRequested',
          payload: {
            requestId,
            projectId: project.id,
            name: spec.name,
            visibility: spec.visibility,
            ...(spec.description ? { description: spec.description } : {}),
            requestedByUserId: user.id,
            deskItemId,
          },
        },
        actor,
        scope,
      },
    ],
  };
}

/**
 * Desk resolution of a repository request (inside the desk resolve transaction). Only the project owner decides: the
 * runner uses their GitHub login. Approving needs one of their workstations to be connected. Returns the workstation
 * to deliver the queued command to, or null (rejected).
 */
export async function resolveRepoCreateIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  item: Row,
  resolution: 'approved' | 'rejected' | 'acknowledged' | 'dismissed',
  note?: string,
): Promise<string | null> {
  if (resolution === 'acknowledged')
    throw badRequest('wrong_resolution', 'a repository request is approved or rejected');
  const req = await one(
    tx,
    `SELECT r.*, p.key AS project_key, p.name AS project_name, p.working_branch FROM repo_requests r
       JOIN projects p ON p.id = r.project_id WHERE r.desk_item_id=$1 FOR UPDATE OF r`,
    [item.id],
  );
  if (!req) throw notFound('repository request not found');
  if (!isOrgManager({ orgRole: await orgRoleOf(tx, user.id, req.org_id) }))
    throw forbidden(
      'only the organization Owner and Admins can approve this: the repository is created with their GitHub login',
    );
  if (req.status !== 'pending') throw conflict('already_decided', `this request is already ${req.status}`);
  const scope = projectScope(req.org_id, req.project_id);
  if (resolution !== 'approved') {
    await ctx.store.append(
      [
        {
          streamId: streamId.repo(req.id),
          event: {
            type: 'RepoCreateRejected',
            payload: { requestId: req.id, by: user.id, ...(note ? { reason: note } : {}) },
          },
          actor: userActor(user.id),
          scope,
        },
        ...(await threadNote(
          tx,
          req.thread_id,
          `The project owner declined creating repository ${req.name}${note ? `: ${note}` : '.'}`,
          { repoRequestId: req.id },
        )),
      ],
      { tx },
    );
    // A conversion waiting for this repository learns that it will not come.
    await settleConversionIn(ctx, tx, req.project_id);
    return null;
  }
  const ws = await connectedWorkstation(tx, user.id);
  if (!ws)
    throw conflict(
      'no_workstation',
      'None of your workstations is connected, so the repository cannot be created now. Start your runner and approve again.',
    );
  await ctx.store.append(
    [
      {
        streamId: streamId.repo(req.id),
        event: {
          type: 'RepoCreateApproved',
          payload: { requestId: req.id, approvedBy: user.id, workstationId: ws.id },
        },
        actor: userActor(user.id),
        scope,
      },
      ...(await threadNote(
        tx,
        req.thread_id,
        `The project owner approved creating repository ${req.name}; ${ws.name} is creating it now.`,
        { repoRequestId: req.id },
      )),
    ],
    { tx },
  );
  await enqueueRunnerCommand(tx, ws.id, 'repo.create', repoCreatePayload(req) as never);
  return ws.id;
}

function repoCreatePayload(req: Row): RepoCreatePayload {
  return {
    requestId: req.id,
    name: req.name,
    visibility: req.visibility,
    ...(req.description ? { description: req.description } : {}),
    ...(req.provider && req.provider !== 'github' ? { provider: req.provider } : {}),
    ...(req.host ? { host: req.host } : {}),
    projectKey: req.project_key,
    projectName: req.project_name,
    branch: req.working_branch || 'main',
  };
}

/**
 * Retry from the "Repository not created" alert (inside the desk resolve transaction). Same rules as approval: only the
 * project owner, with a connected workstation of theirs. The request must be `failed`. The same request id is queued
 * again; the runner's create is idempotent (it reuses an empty repository the owner already owns and its own clone).
 */
export async function retryRepoCreateIn(ctx: Ctx, tx: Tx, user: { id: string }, item: Row): Promise<string> {
  const req = await one(
    tx,
    `SELECT r.*, p.key AS project_key, p.name AS project_name, p.working_branch FROM repo_requests r
       JOIN projects p ON p.id = r.project_id
      WHERE r.id = (SELECT (payload->>'requestId')::uuid FROM events
                     WHERE type='RepoCreateFailed' AND payload->>'alertDeskItemId' = $1
                     ORDER BY seq DESC LIMIT 1) FOR UPDATE OF r`,
    [item.id],
  );
  if (!req) throw notFound('repository request not found');
  if (!isOrgManager({ orgRole: await orgRoleOf(tx, user.id, req.org_id) }))
    throw forbidden(
      'only the organization Owner and Admins can approve this: the repository is created with their GitHub login',
    );
  if (req.status !== 'failed')
    throw conflict('not_failed', `this request is ${req.status}, only a failed request can be retried`);
  const ws = await connectedWorkstation(tx, user.id);
  if (!ws)
    throw conflict(
      'no_workstation',
      'None of your workstations is connected, so the repository cannot be created now. Start your runner and retry.',
    );
  await ctx.store.append(
    [
      {
        streamId: streamId.repo(req.id),
        event: {
          type: 'RepoCreateRetried',
          payload: { requestId: req.id, by: user.id, workstationId: ws.id },
        },
        actor: userActor(user.id),
        scope: projectScope(req.org_id, req.project_id),
      },
      ...(await threadNote(
        tx,
        req.thread_id,
        `The project owner retried creating repository ${req.name}; ${ws.name} is creating it now.`,
        { repoRequestId: req.id },
      )),
    ],
    { tx },
  );
  await enqueueRunnerCommand(tx, ws.id, 'repo.create', repoCreatePayload(req) as never);
  return ws.id;
}

/**
 * The runner's answer to `repo.create`. Only the workstation it was approved for counts, and only while the request
 * is `approved`: a repeated answer changes nothing, so a redelivered command never adds a second project repository.
 * Success adds the repository to the project exactly like the owner's settings page; a failure lands on the desk.
 */
export async function applyRepoCreateResult(
  ctx: Ctx,
  workstationId: string,
  requestId: string,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const parsed = RepoCreateResultSchema.safeParse(result);
  const r = parsed.success ? parsed.data : { ok: false as const };
  let failure = r.error ?? error ?? 'the repository could not be created';
  await withAppendTx(ctx.pool, async (tx) => {
    const req = await one(
      tx,
      `SELECT r.*, p.key AS project_key, p.name AS project_name, p.org_id AS project_org, p.id AS pid
         FROM repo_requests r JOIN projects p ON p.id = r.project_id WHERE r.id=$1 FOR UPDATE OF r`,
      [requestId],
    );
    if (!req || req.status !== 'approved' || req.workstation_id !== workstationId) return;
    const scope = projectScope(req.org_id, req.project_id);
    if (ok && r.ok && r.remoteUrl) {
      try {
        const normalizedExisting = await one(
          tx,
          `SELECT id FROM project_repos WHERE project_id=$1 AND removed_at IS NULL AND remote_url_normalized = $2`,
          [req.project_id, normalizeRemoteUrl(r.remoteUrl)],
        );
        const repoId =
          normalizedExisting?.id ??
          (await addRepoIn(
            ctx,
            tx,
            { id: req.project_id, org_id: req.org_id },
            {
              name: lastSegment(req.name),
              remoteUrl: r.remoteUrl,
              workingBranch: 'main',
              ...(req.provider && req.provider !== 'github' ? { forge: req.provider } : {}),
            },
            req.requested_by_agent_id
              ? agentActor(req.requested_by_agent_id)
              : req.requested_by_user_id
                ? userActor(req.requested_by_user_id)
                : SYSTEM_ACTOR,
          ));
        await ctx.store.append(
          [
            {
              streamId: streamId.repo(req.id),
              event: {
                type: 'RepoCreateCompleted',
                payload: {
                  requestId: req.id,
                  remoteUrl: r.remoteUrl,
                  ...(r.localPath ? { localPath: r.localPath } : {}),
                  projectRepoId: repoId,
                  existing: !!r.existing,
                },
              },
              actor: SYSTEM_ACTOR,
              scope,
            },
            ...(await threadNote(
              tx,
              req.thread_id,
              `Repository ${req.name} is ready (${r.remoteUrl}) and was added to project ${req.project_key} as repo '${lastSegment(req.name)}'. You can create cards on it now.`,
              { repoRequestId: req.id, remoteUrl: r.remoteUrl },
            )),
          ],
          { tx },
        );
        // A conversion waiting for this repository can complete now.
        await settleConversionIn(ctx, tx, req.project_id);
        return;
      } catch (err) {
        failure = `the repository was created but could not be added to the project: ${err instanceof Error ? err.message : String(err)}`;
      }
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
              subkind: DESK_SUBKIND.repoCreateFailed,
              title: `Could not create repository ${req.name}`,
              body: `${failure}\n\nNothing was added to project ${req.project_key}. Once this is fixed, retry here (the same request is run again on your workstation) or dismiss this and ask the agent to request it again.`,
              options: [
                { id: 'retry', label: 'Retry' },
                { id: 'dismiss', label: 'Dismiss' },
              ],
              blocking: false,
              pinned: false,
              projectId: req.project_id,
              affectedCardIds: [],
              askedBy: { kind: 'system' },
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        {
          streamId: streamId.repo(req.id),
          event: {
            type: 'RepoCreateFailed',
            payload: { requestId: req.id, error: failure.slice(0, 4000), alertDeskItemId: alertId },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        ...(await threadNote(tx, req.thread_id, `Creating repository ${req.name} failed: ${failure}`, {
          repoRequestId: req.id,
        })),
      ],
      { tx },
    );
  });
}
