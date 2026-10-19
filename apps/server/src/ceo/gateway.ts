import { CEO_ROLE_KEY, type CeoRpc, CeoRpcSchema, renderCeoData, streamId } from '@aom/shared';
import { agentActor, orgScope, runnerActor, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { HttpError } from '../errors.ts';
import { recordCorrection } from './corrections.ts';
import {
  type CallOrigin,
  defaultKey,
  makeEnv,
  ownerPrincipal,
  recommendOnItem,
  runAction,
} from './engine.ts';
import { jobOp } from './jobs.ts';
import { addMemory, searchMemories } from './memory.ts';
import { notifyOwner } from './notify.ts';
import { orderTurnTerminal } from './order-turns.ts';
import { currentAuthority } from './orders.ts';
import { askPermission, pollPermission } from './permissions.ts';
import { ceoReviewReply } from './review.ts';
import { buildSnapshot } from './snapshot.ts';
import { loadCeo } from './state.ts';
import { createTask, listTasks, updateTask } from './tasks.ts';

type Reply = [boolean, unknown?, string?];

const WRITE_OPS = new Set([
  'act',
  'recommend',
  'notify',
  'task',
  'memory',
  'review_reply',
  'correction',
  'order',
  'dir',
]);

/** The durable subject of a notify call: the card (with its stage and status) behind a desk item, the desk item, or the task. */
async function noticeSubject(
  ctx: Ctx,
  orgId: string,
  rpc: { kind: string; item?: string | undefined; task?: string | undefined },
): Promise<{ key: string; state: string } | undefined> {
  if (rpc.item) {
    const d = await one(
      ctx.pool,
      'SELECT card_id, status, subkind FROM desk_items WHERE id=$1 AND org_id=$2',
      [rpc.item, orgId],
    );
    if (d?.card_id) {
      const c = await one(ctx.pool, 'SELECT stage, status FROM cards WHERE id=$1', [d.card_id]);
      return { key: `card:${d.card_id}:notify:${rpc.kind}`, state: c ? `${c.stage}/${c.status}` : '' };
    }
    if (d) return { key: `desk:${rpc.item}:notify:${rpc.kind}`, state: d.status };
  }
  if (rpc.task) {
    const t = await one(ctx.pool, 'SELECT status FROM ceo_tasks WHERE id=$1 AND org_id=$2', [
      rpc.task,
      orgId,
    ]);
    if (t) return { key: `task:${rpc.task}:notify:${rpc.kind}`, state: t.status };
  }
  return undefined;
}

/**
 * `rpc ceo` from a CEO shift or from the owner's chat with the CEO (docs/design/ceo-agent-v2.md section 4.2): the token
 * must belong to a shift of the organization's CEO agent; anything else is refused. Reads are free; writes go through the
 * engine (idempotency, policy, limits, audit) or the small owner-facing helpers (notify, tasks, memory).
 */
export async function ceoRpc(ctx: Ctx, shift: Row, params: Record<string, unknown>): Promise<Reply> {
  const agent = await one(ctx.pool, 'SELECT id, name, org_id, role_key, status FROM agents WHERE id=$1', [
    shift.agent_id,
  ]);
  if (!agent || agent.role_key !== CEO_ROLE_KEY)
    return [false, undefined, 'not_ceo: only the CEO may use `aom ceo`'];
  if (shift.kind !== 'ceo' && shift.kind !== 'chat') return [false, undefined, 'not_ceo: not a CEO shift'];
  const ceo = await loadCeo(ctx.pool, agent.org_id);
  if (!ceo || !ceo.enabled || ceo.agentId !== agent.id) return [false, undefined, 'the CEO is disabled'];
  const parsed = CeoRpcSchema.safeParse(params);
  if (!parsed.success)
    return [
      false,
      undefined,
      `invalid request: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'request'} ${i.message}`).join('; ')}`,
    ];
  const rpc = parsed.data;
  if (ceo.paused && WRITE_OPS.has(rpc.op))
    return [false, undefined, 'the CEO is paused: it may read but not act'];

  const orgId = agent.org_id as string;
  // Where the call comes from, from the server's OWN records (never a field the runner or the model supplies): the owner's
  // chat turn, an order turn (`ceo_turns`), or a wake whose reasons may carry outside text (`ceo_batches`).
  let origin: CallOrigin;
  let turn: Row | undefined;
  if (shift.kind === 'chat') {
    turn = await one(ctx.pool, 'SELECT * FROM ceo_turns WHERE id=$1 AND org_id=$2', [shift.id, orgId]);
    const threadId =
      turn?.thread_id ?? ctx.services.chat.threadOfChat(shift.id) ?? ceo.chatThreadId ?? undefined;
    if (turn?.mode === 'order') {
      const auth = turn.order_entry_id ? await currentAuthority(ctx.pool, turn.order_entry_id) : undefined;
      if (!auth || auth.versionHash !== turn.order_version_hash)
        return [
          false,
          undefined,
          'the authority of this order is no longer in force (it was edited, revoked or retired): stop, and say so in `aom ceo order done`',
        ];
      origin = {
        kind: 'order',
        scopeId: shift.id,
        turnId: shift.id,
        chatThreadId: threadId,
        untrusted: false,
        order: { entryId: auth.entryId, versionHash: auth.versionHash, covers: auth.covers },
      };
    } else
      origin = {
        kind: 'owner',
        scopeId: shift.id,
        chatThreadId: threadId,
        ...(turn ? { turnId: shift.id } : {}),
        untrusted: false,
      };
  } else {
    const batch = await one(ctx.pool, 'SELECT id FROM ceo_batches WHERE shift_id=$1', [shift.id]);
    const u = batch
      ? await one<{ u: boolean | null }>(
          ctx.pool,
          'SELECT bool_or(untrusted) AS u FROM ceo_wakes WHERE batch_id=$1',
          [batch.id],
        )
      : undefined;
    origin = { kind: 'wake', scopeId: batch?.id ?? shift.id, batchId: batch?.id, untrusted: u?.u === true };
  }
  const kind = origin.kind as 'owner' | 'order' | 'wake';
  const owner = await ownerPrincipal(ctx, orgId);
  const env = makeEnv(ctx, ceo, { id: agent.id, name: agent.name }, owner, origin);

  try {
    switch (rpc.op) {
      case 'correction': {
        // "You did X, I'd rather Y": the owner's words from his own turn (an order or a wake never records one).
        if (kind !== 'owner' || !turn)
          return [false, undefined, "corrections are recorded in the owner's chat turn only"];
        const r = await recordCorrection(ctx, owner, orgId, {
          ...(rpc.action ? { actionId: rpc.action } : {}),
          ...(turn.message_id ? { chatMessageId: turn.message_id } : {}),
          text: rpc.text,
          rule: rpc.rule,
          remedy: rpc.remedy === 'undo' ? 'undo' : 'none',
          makeRule: true,
          threadId: turn.thread_id,
          viaCeo: true,
        });
        return [true, { status: 'executed', ...r }];
      }
      case 'job': {
        if (rpc.sub !== 'repeats' && kind === 'wake')
          return [false, undefined, 'the job log belongs to an owner or order turn'];
        return [true, await jobOp(ctx, turn, agent.id, orgId, rpc)];
      }
      case 'order': {
        if (rpc.sub === 'invoke') {
          if (kind !== 'wake') return [false, undefined, 'only a wake may start an order turn'];
          if (!rpc.entryId) return [false, undefined, 'give the order id'];
          const r = await runAction(
            env,
            {
              op: 'act',
              action: 'invoke-order',
              params: { entryId: rpc.entryId, ...(rpc.wake ? { wake: rpc.wake } : {}), why: rpc.why ?? '' },
              reason:
                (rpc.why ?? 'the event falls under this order').slice(0, 2000) ||
                'the event falls under this order',
              confidence: rpc.confidence ?? 0.8,
              evidence: [],
              dryRun: false,
            },
            origin,
          );
          return [true, r];
        }
        if (kind !== 'order' || !turn)
          return [false, undefined, 'only an order turn declines or finishes an order'];
        return [true, await orderTurnTerminal(ctx, turn, rpc)];
      }
      case 'permission': {
        if (kind === 'wake' || !turn)
          return [false, undefined, 'permission questions belong to an owner or order turn'];
        if (rpc.sub === 'ask') return [true, await askPermission(ctx, turn, rpc)];
        if (!rpc.askId) return [false, undefined, 'give the question id'];
        return [true, await pollPermission(ctx, turn, rpc.askId)];
      }
      case 'devops_status':
        return [true, await devopsStatus(ctx, orgId, rpc.requestId)];
      case 'dir': {
        if (kind !== 'owner' || !turn)
          return [false, undefined, "working directories are added in the owner's turn"];
        const cur =
          (await one(ctx.pool, 'SELECT dirs FROM threads WHERE id=$1', [turn.thread_id]))?.dirs ?? [];
        if (!cur.includes(rpc.path) && cur.length < 20)
          await ctx.store.append([
            {
              streamId: streamId.thread(turn.thread_id),
              event: {
                type: 'ChatThreadDirsSet',
                payload: { threadId: turn.thread_id, dirs: [...cur, rpc.path], by: owner.id },
              },
              actor: userActor(owner.id),
              scope: orgScope(orgId),
            },
          ]);
        return [
          true,
          {
            status: 'executed',
            message: `Added ${rpc.path}: it is part of this conversation from the next turn on.`,
          },
        ];
      }
      case 'restart': {
        if (kind !== 'owner' || !turn || !shift.workstation_id)
          return [false, undefined, "the runner restarts from the owner's turn only"];
        await ctx.store.append([
          {
            streamId: streamId.ceo(orgId),
            event: {
              type: 'RunnerRestartRequested',
              payload: {
                workstationId: shift.workstation_id,
                orgId,
                by: `turn:${turn.id}`,
                ...(rpc.reason ? { reason: rpc.reason } : {}),
              },
            },
            actor: runnerActor(shift.workstation_id),
            scope: orgScope(orgId),
          },
        ]);
        await ctx.pool.query(
          `INSERT INTO ceo_flags (org_id, flag, value, at) VALUES ($1,$2,$3,$4)
           ON CONFLICT (org_id, flag) DO UPDATE SET value=EXCLUDED.value, at=EXCLUDED.at`,
          [orgId, `restart:${shift.workstation_id}`, rpc.reason ?? '', ctx.clock.now()],
        );
        return [true, { status: 'executed', message: 'Restart scheduled after this reply.' }];
      }
      case 'snapshot':
        return [true, { text: await buildSnapshot(ctx, orgId, rpc.section) }];
      case 'show':
        return [true, { text: await show(ctx, orgId, rpc) }];
      case 'search':
        return [true, { text: await search(ctx, orgId, rpc) }];
      case 'costs':
        return [true, { text: await costs(ctx, orgId, rpc.days) }];
      case 'route':
        // Read-only, and answered by the workstation from the organization graph in the organization vault: derived
        // links never reach the server, so there is nothing to answer from here (docs/design/project-graphs.md section 8).
        return [
          true,
          {
            text: 'The organization graph is read on the workstation that holds the organization vault; it is not available from here.',
          },
        ];
      case 'act': {
        const r = await runAction(env, rpc, origin);
        return [true, r];
      }
      case 'recommend': {
        if (rpc.item) return [true, await recommendOnItem(env, rpc, origin)];
        if (!rpc.action)
          return [
            false,
            undefined,
            'give --item (advice on a desk item) or --action with its parameters (a recommendation for the owner)',
          ];
        // A recommendation for an action: evaluated as a call that may never execute.
        const r = await runAction(
          env,
          {
            op: 'act',
            action: rpc.action,
            params: rpc.params ?? {},
            reason: rpc.reason,
            confidence: rpc.confidence,
            evidence: rpc.evidence,
            ...(rpc.key ? { key: rpc.key } : {}),
            dryRun: false,
          },
          origin,
          { recommendOnly: true },
        );
        return [true, r];
      }
      case 'notify': {
        // The dedupe key is the subject (a card, a desk item, a task) and its state, not the wording: the CEO rewording
        // a reminder about a subject it already handled raises nothing. Only a notice about no subject falls back to the text.
        const subject = rpc.key ? undefined : await noticeSubject(ctx, orgId, rpc);
        const key =
          rpc.key ?? subject?.key ?? defaultKey(origin.scopeId, 'notify', { k: rpc.kind, t: rpc.text });
        const dup = subject
          ? undefined
          : await one(ctx.pool, 'SELECT 1 FROM ceo_flags WHERE org_id=$1 AND flag=$2', [
              orgId,
              `notify:${key}`,
            ]);
        if (dup) return [true, { status: 'duplicate', message: 'Already sent.' }];
        const r = await notifyOwner(ctx, orgId, {
          kind: rpc.kind,
          title: rpc.title ?? rpc.text.slice(0, 120),
          text: rpc.text,
          taskId: rpc.task,
          deskItemId: rpc.item,
          subject: key,
          ...(subject ? { once: subject } : {}),
        });
        if (r.suppressed)
          return [
            true,
            { status: 'duplicate', message: 'Already sent for this subject; it has not changed.' },
          ];
        await ctx.pool.query(
          `INSERT INTO ceo_flags (org_id, flag, value, at) VALUES ($1,$2,'1',$3) ON CONFLICT DO NOTHING`,
          [orgId, `notify:${key}`, ctx.clock.now()],
        );
        return [
          true,
          {
            status: 'executed',
            message: r.emailed ? 'The owner was notified (desk and e-mail).' : 'The owner was notified.',
          },
        ];
      }
      case 'task':
        return [true, await taskOp(ctx, env.agentId, orgId, rpc, origin)];
      case 'memory':
        return [true, await memoryOp(ctx, agent, orgId, rpc, origin)];
      case 'review_reply':
        return [true, await ceoReviewReply(ctx, agent, orgId, rpc)];
      default:
        return [false, undefined, 'unknown operation'];
    }
  } catch (err) {
    if (err instanceof HttpError) return [false, undefined, err.message];
    throw err;
  }
}

/** The state of a DevOps request the CEO filed (`aom ceo act devops --wait` polls it): status, summary and the last progress lines. */
async function devopsStatus(ctx: Ctx, orgId: string, requestId: string): Promise<Record<string, unknown>> {
  const r = await one(
    ctx.pool,
    'SELECT id, status, summary, result_summary, thread_id, updated_at FROM devops_requests WHERE id=$1 AND org_id=$2',
    [requestId, orgId],
  );
  if (!r) return { status: 'unknown', message: 'no such DevOps request' };
  const lines = await rows(
    ctx.pool,
    `SELECT author_kind, kind, body FROM thread_messages WHERE thread_id=$1 AND kind IN ('comment','system','handoff','chat')
      ORDER BY created_at DESC, event_seq DESC LIMIT 6`,
    [r.thread_id],
  );
  return {
    requestId: r.id,
    status: r.status,
    done: r.status === 'done' || r.status === 'failed',
    summary: r.result_summary ?? null,
    progress: lines
      .reverse()
      .filter((l) => l.author_kind !== 'user')
      .map((l) => String(l.body).slice(0, 300)),
  };
}

async function show(ctx: Ctx, orgId: string, rpc: Extract<CeoRpc, { op: 'show' }>): Promise<string> {
  const ref = rpc.ref;
  if (rpc.kind === 'card') {
    const c = await one(
      ctx.pool,
      `SELECT c.*, p.key AS project_key, a.name AS agent_name FROM cards c JOIN projects p ON p.id=c.project_id
         LEFT JOIN agents a ON a.id=c.claimed_by_agent_id WHERE c.org_id=$1 AND (c.ref=$2 OR c.id::text=$2)`,
      [orgId, ref],
    );
    if (!c) return 'card not found';
    const msgs = await rows(
      ctx.pool,
      `SELECT kind, body, author_kind, created_at FROM thread_messages WHERE thread_id=$1 ORDER BY created_at DESC LIMIT 6`,
      [c.id],
    );
    return [
      `${c.ref} id=${c.id} status=${c.status} stage=${c.stage} priority=${c.priority} rework=${c.rework_round} agent=${c.agent_name ?? '-'}${c.retry_after ? ` backoff_until=${new Date(c.retry_after).toISOString()}` : ''}`,
      renderCeoData(
        `Card ${c.ref}`,
        `${c.title}\n\nRecent thread:\n${msgs
          .reverse()
          .map((m) => `[${m.author_kind}/${m.kind}] ${String(m.body).slice(0, 500)}`)
          .join('\n')}`,
      ),
    ].join('\n');
  }
  if (rpc.kind === 'agent') {
    const a = await one(
      ctx.pool,
      `SELECT * FROM agents WHERE org_id=$1 AND (lower(name)=lower($2) OR id::text=$2)`,
      [orgId, ref],
    );
    if (!a) return 'agent not found';
    const recent = await rows(
      ctx.pool,
      `SELECT kind, outcome, started_at FROM shifts WHERE agent_id=$1 ORDER BY started_at DESC LIMIT 8`,
      [a.id],
    );
    return `${a.name} id=${a.id} ${a.role_key}/${a.seniority} ${a.model} status=${a.status}${a.paused_at ? ' PAUSED' : ''}\nrecent shifts: ${recent.map((s) => `${s.kind}:${s.outcome ?? 'running'}`).join(', ') || 'none'}`;
  }
  if (rpc.kind === 'desk-item') {
    const d = await one(ctx.pool, `SELECT * FROM desk_items WHERE org_id=$1 AND id::text=$2`, [orgId, ref]);
    if (!d) return 'desk item not found';
    return [
      `item=${d.id} ${d.kind}${d.subkind ? `:${d.subkind}` : ''} status=${d.status}${d.blocking ? ' BLOCKING' : ''} options=${JSON.stringify(d.options)}`,
      renderCeoData('Desk item', `${d.title}\n\n${d.body ?? ''}`),
    ].join('\n');
  }
  if (rpc.kind === 'shift') {
    const s = await one(
      ctx.pool,
      `SELECT s.*, a.name FROM shifts s JOIN agents a ON a.id=s.agent_id WHERE s.org_id=$1 AND s.id::text=$2`,
      [orgId, ref],
    );
    return s
      ? `shift=${s.id} ${s.kind} agent=${s.name} status=${s.status} outcome=${s.outcome ?? '-'} started=${new Date(s.started_at).toISOString()}`
      : 'shift not found';
  }
  if (rpc.kind === 'project') {
    const p = await one(
      ctx.pool,
      `SELECT * FROM projects WHERE org_id=$1 AND (key=upper($2) OR id::text=$2)`,
      [orgId, ref],
    );
    return p
      ? `${p.key} id=${p.id} status=${p.status} budget=${p.budget_micros ?? 'none'}`
      : 'project not found';
  }
  const w = await one(
    ctx.pool,
    `SELECT * FROM workstations WHERE status='active' AND (lower(name)=lower($1) OR id::text=$1)`,
    [ref],
  );
  return w
    ? `${w.name} id=${w.id} connected=${w.connected} runner=${w.runner_version ?? '?'} runtimes=${JSON.stringify(w.runtimes)}`
    : 'workstation not found';
}

async function search(ctx: Ctx, orgId: string, rpc: Extract<CeoRpc, { op: 'search' }>): Promise<string> {
  const like = `%${rpc.q.replace(/[%_]/g, '')}%`;
  if (rpc.in === 'memory') {
    const m = await searchMemories(ctx, orgId, rpc.q);
    return (
      m.map((x) => `memory:${x.id} [${x.kind}, ${Math.round(x.confidence * 100)}%] ${x.text}`).join('\n') ||
      'no memories match'
    );
  }
  if (rpc.in === 'cards') {
    const c = await rows(
      ctx.pool,
      `SELECT ref, id, status, title FROM cards WHERE org_id=$1 AND title ILIKE $2 ORDER BY updated_at DESC LIMIT 10`,
      [orgId, like],
    );
    return c.length
      ? renderCeoData('Cards', c.map((x) => `${x.ref} (${x.status}) ${x.title}`).join('\n'))
      : 'no cards match';
  }
  const d = await rows(
    ctx.pool,
    `SELECT id, kind, subkind, status, title FROM desk_items WHERE org_id=$1 AND title ILIKE $2 ORDER BY created_at DESC LIMIT 10`,
    [orgId, like],
  );
  return d.length
    ? renderCeoData(
        'Desk items',
        d.map((x) => `${x.id} ${x.kind}:${x.subkind ?? ''} ${x.status} ${x.title}`).join('\n'),
      )
    : 'no desk items match';
}

async function costs(ctx: Ctx, orgId: string, days: number): Promise<string> {
  const since = new Date(ctx.clock.now().getTime() - days * 86_400_000);
  const r = await rows(
    ctx.pool,
    `SELECT COALESCE(p.key,'(overhead)') AS project, sc.kind, round(sum(sc.cost_usd_micros)/1e6, 2) AS usd, count(*) AS shifts
       FROM shift_costs sc LEFT JOIN projects p ON p.id=sc.project_id WHERE sc.org_id=$1 AND sc.ended_at >= $2
      GROUP BY 1,2 ORDER BY sum(sc.cost_usd_micros) DESC LIMIT 40`,
    [orgId, since],
  );
  return `Spend, last ${days} days (USD):\n${r.map((x) => `${x.project} ${x.kind}: $${x.usd} (${x.shifts} shifts)`).join('\n') || 'none'}`;
}

async function taskOp(
  ctx: Ctx,
  agentId: string,
  orgId: string,
  rpc: Extract<CeoRpc, { op: 'task' }>,
  origin: CallOrigin,
): Promise<unknown> {
  if (rpc.sub === 'list') return { tasks: await listTasks(ctx, orgId, true) };
  // Tasks come from the owner: only the owner's chat opens one.
  if (rpc.sub === 'create') {
    if (!origin.chatThreadId || origin.untrusted || origin.kind === 'order')
      return {
        status: 'refused',
        message: "tasks are opened from the owner's chat, not from a wake or an order",
      };
    if (!rpc.title) return { status: 'refused', message: 'a title is required' };
    const id = await createTask(ctx, orgId, {
      title: rpc.title,
      request: rpc.request,
      threadId: origin.chatThreadId,
      due: rpc.due,
      watch: rpc.watch,
      by: { kind: 'ceo', agentId },
    });
    return {
      status: 'executed',
      taskId: id,
      message:
        'Task opened. Delegate it, link what you create with `task update --watch`, and mark it done when it is.',
    };
  }
  if (!rpc.id) return { status: 'refused', message: 'give the task id' };
  await updateTask(
    ctx,
    orgId,
    rpc.id,
    { status: rpc.status, note: rpc.note, watch: rpc.watch, due: rpc.due },
    'ceo',
    agentActor(agentId),
  );
  return { status: 'executed', message: 'Task updated.' };
}

async function memoryOp(
  ctx: Ctx,
  agent: Row,
  orgId: string,
  rpc: Extract<CeoRpc, { op: 'memory' }>,
  origin: CallOrigin,
): Promise<unknown> {
  if (rpc.sub === 'confirm')
    return { status: 'refused', message: 'only the owner confirms a memory (the Memory tab)' };
  if (!rpc.text) return { status: 'refused', message: 'give the rule with --text' };
  // Memories come from owner-authored sources only: the owner's chat, or the owner's own desk answer.
  if (origin.untrusted || !origin.chatThreadId || origin.kind === 'order')
    if (!(rpc.source?.startsWith('desk:') && !origin.untrusted && origin.kind !== 'order'))
      return {
        status: 'refused',
        message: 'a memory may only come from what the owner said in the CEO chat or answered on the desk',
      };
  let source: 'owner_statement' | 'owner_desk_answer' = 'owner_statement';
  let sourceRef = `chat:${origin.chatThreadId ?? ''}`;
  if (rpc.source?.startsWith('desk:')) {
    const id = rpc.source.slice(5);
    const d = await one(
      ctx.pool,
      `SELECT id, status, answered_by FROM desk_items WHERE id::text=$1 AND org_id=$2`,
      [id, orgId],
    );
    if (!d || d.status !== 'answered' || !d.answered_by)
      return { status: 'refused', message: 'that desk item was not answered by the owner' };
    source = 'owner_desk_answer';
    sourceRef = `desk:${id}`;
  } else if (!origin.chatThreadId)
    return { status: 'refused', message: 'the owner has to say it in the chat' };
  const id = await addMemory(ctx, {
    orgId,
    kind: rpc.kind,
    scope: rpc.scope,
    source,
    sourceRef,
    confidence: 0.95,
    status: 'active',
    text: rpc.text,
    ...(rpc.quote ? { quote: rpc.quote } : {}),
    byAgentId: agent.id,
  });
  return {
    status: 'executed',
    memoryId: id,
    message: 'Remembered. It will be listed as "I noted" in the next report.',
  };
}
