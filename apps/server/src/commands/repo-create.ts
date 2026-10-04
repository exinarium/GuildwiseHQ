import { randomUUID } from 'node:crypto';
import {
  BA_ROLE_KEY,
  DESK_SUBKIND,
  normalizeRemoteUrl,
  RepoCreateParamsSchema,
  type RepoCreatePayload,
  RepoCreateResultSchema,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { agentActor, orgScope, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { addRepoIn } from './projects.ts';

/**
 * Approved repository setup (docs/SPEC.md "External systems boundary"). Agents cannot create repositories: the sandbox
 * has no GitHub credentials and `git push` is denied. The BA (in any chat) or the DevOps engineer asks with
 * `aom repo create`; the request lands on the project owner's desk; on approval the server queues `repo.create` for the
 * owner's own connected workstation, whose runner creates the repository with the owner's local `gh` login, pushes the
 * first commit, clones it under a repo root and reports the URL. The server then adds it to the project.
 */

type RpcReply = [boolean, unknown?, string?];
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
      `invalid request: ${issuesText(p.error.issues)}. usage: aom repo create --name <owner/repo> --private|--public --project <KEY> [--description "<text>"]`,
    ];
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [shift.agent_id]);
  if (!agent) return [false, undefined, 'unknown agent'];
  let userId: string | undefined;
  let threadId: string | null = null;
  if (shift.kind === 'chat' && (agent.role_key === BA_ROLE_KEY || agent.is_devops)) {
    userId = ctx.services.chat.userOfChat(shift.id);
    threadId = ctx.services.chat.threadOfChat(shift.id) ?? null;
  } else if (shift.kind === 'devops' && agent.is_devops) {
    const req = await one(ctx.pool, 'SELECT org_id, thread_id FROM devops_requests WHERE shift_id=$1', [
      shift.id,
    ]);
    userId = req?.org_id;
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
    `SELECT p.id, p.key, p.name, p.org_id FROM projects p
       JOIN project_members m ON m.project_id = p.id AND m.user_id = $1 AND m.status = 'active'
      WHERE p.key = $2 AND p.status = 'active'`,
    [userId, p.data.project.toUpperCase()],
  );
  if (!project)
    return [false, undefined, `unknown project '${p.data.project}' (use a project key you may work in)`];
  if (!(await connectedWorkstation(ctx.pool, project.org_id)))
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
          ? `${r.name} was already created and added to project ${r.project_key}; use it as repo '${String(r.name).split('/')[1]}'.`
          : `A request for ${r.name} is already waiting for the project owner's approval on the desk. Tell the manager; do not ask again.`,
    },
  ];
  const dup = await live();
  if (dup) return already(dup);

  const requestId = randomUUID();
  const deskItemId = randomUUID();
  const ws = await connectedWorkstation(ctx.pool, project.org_id);
  const body = [
    `Repository: ${p.data.name}`,
    `Visibility: ${p.data.visibility}`,
    `Project: ${project.key} (${project.name})`,
    ...(p.data.description ? [`Description: ${p.data.description}`] : []),
    `Requested by: ${agent.name}`,
    `Runs on: ${ws?.name ?? 'your connected workstation'} (your workstation)`,
    '',
    `Approving creates this repository on GitHub with your own GitHub login on that workstation (gh), pushes a first commit (README.md) to main, clones it next to your other repositories and adds it to project ${project.key}. Nothing is created until you approve.`,
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
  if (req.org_id !== user.id)
    throw forbidden(
      'only the project owner can approve this: the repository is created with their GitHub login',
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
  const payload: RepoCreatePayload = {
    requestId: req.id,
    name: req.name,
    visibility: req.visibility,
    ...(req.description ? { description: req.description } : {}),
    projectKey: req.project_key,
    projectName: req.project_name,
    branch: req.working_branch || 'main',
  };
  await enqueueRunnerCommand(tx, ws.id, 'repo.create', payload as never);
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
              name: String(req.name).split('/')[1] as string,
              remoteUrl: r.remoteUrl,
              workingBranch: 'main',
            },
            agentActor(req.requested_by_agent_id),
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
              `Repository ${req.name} is ready (${r.remoteUrl}) and was added to project ${req.project_key} as repo '${String(req.name).split('/')[1]}'. You can create cards on it now.`,
              { repoRequestId: req.id, remoteUrl: r.remoteUrl },
            )),
          ],
          { tx },
        );
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
              body: `${failure}\n\nNothing was added to project ${req.project_key}. Ask the agent to request it again once this is fixed.`,
              options: [],
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
