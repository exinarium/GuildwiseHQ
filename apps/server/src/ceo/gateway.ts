import { CEO_ROLE_KEY, type CeoRpc, CeoRpcSchema, renderUntrusted } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { agentActor } from '../commands/common.ts';
import { HttpError } from '../errors.ts';
import { type CallOrigin, defaultKey, makeEnv, ownerPrincipal, recommendOnItem, runAction } from './engine.ts';
import { addMemory, searchMemories } from './memory.ts';
import { notifyOwner } from './notify.ts';
import { buildSnapshot } from './snapshot.ts';
import { loadCeo } from './state.ts';
import { createTask, listTasks, updateTask } from './tasks.ts';

type Reply = [boolean, unknown?, string?];

const WRITE_OPS = new Set(['act', 'recommend', 'notify', 'task', 'memory']);

/**
 * `rpc ceo` from a CEO shift or from the owner's chat with the CEO (docs/design/ceo-agent-v2.md section 4.2): the token
 * must belong to a shift of the organization's CEO agent; anything else is refused. Reads are free; writes go through the
 * engine (idempotency, policy, limits, audit) or the small owner-facing helpers (notify, tasks, memory).
 */
export async function ceoRpc(ctx: Ctx, shift: Row, params: Record<string, unknown>): Promise<Reply> {
  const agent = await one(ctx.pool, 'SELECT id, name, org_id, role_key, status FROM agents WHERE id=$1', [shift.agent_id]);
  if (!agent || agent.role_key !== CEO_ROLE_KEY) return [false, undefined, 'not_ceo: only the CEO may use `aom ceo`'];
  if (shift.kind !== 'ceo' && shift.kind !== 'chat') return [false, undefined, 'not_ceo: not a CEO shift'];
  const ceo = await loadCeo(ctx.pool, agent.org_id);
  if (!ceo || !ceo.enabled || ceo.agentId !== agent.id) return [false, undefined, 'the CEO is disabled'];
  const parsed = CeoRpcSchema.safeParse(params);
  if (!parsed.success)
    return [false, undefined, `invalid request: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'request'} ${i.message}`).join('; ')}`];
  const rpc = parsed.data;
  if (ceo.paused && WRITE_OPS.has(rpc.op)) return [false, undefined, 'the CEO is paused: it may read but not act'];

  const orgId = agent.org_id as string;
  // Where the call comes from: the owner's chat, or a wake whose reasons may carry outside text.
  let origin: CallOrigin;
  if (shift.kind === 'chat') {
    const threadId = ctx.services.chat.threadOfChat(shift.id) ?? ceo.chatThreadId ?? undefined;
    origin = { scopeId: shift.id, chatThreadId: threadId, untrusted: false };
  } else {
    const batch = await one(ctx.pool, 'SELECT id FROM ceo_batches WHERE shift_id=$1', [shift.id]);
    const u = batch
      ? await one<{ u: boolean | null }>(ctx.pool, 'SELECT bool_or(untrusted) AS u FROM ceo_wakes WHERE batch_id=$1', [batch.id])
      : undefined;
    origin = { scopeId: batch?.id ?? shift.id, batchId: batch?.id, untrusted: u?.u === true };
  }
  const owner = await ownerPrincipal(ctx, orgId);
  const env = makeEnv(ctx, ceo, { id: agent.id, name: agent.name }, owner, origin);

  try {
    switch (rpc.op) {
      case 'snapshot':
        return [true, { text: await buildSnapshot(ctx, orgId, rpc.section) }];
      case 'show':
        return [true, { text: await show(ctx, orgId, rpc) }];
      case 'search':
        return [true, { text: await search(ctx, orgId, rpc) }];
      case 'costs':
        return [true, { text: await costs(ctx, orgId, rpc.days) }];
      case 'act': {
        const r = await runAction(env, rpc, origin);
        return [true, r];
      }
      case 'recommend': {
        if (rpc.item) return [true, await recommendOnItem(env, rpc, origin)];
        if (!rpc.action)
          return [false, undefined, 'give --item (advice on a desk item) or --action with its parameters (a recommendation for the owner)'];
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
        const key = rpc.key ?? defaultKey(origin.scopeId, 'notify', { k: rpc.kind, t: rpc.text });
        const dup = await one(ctx.pool, 'SELECT 1 FROM ceo_flags WHERE org_id=$1 AND flag=$2', [orgId, `notify:${key}`]);
        if (dup) return [true, { status: 'duplicate', message: 'Already sent.' }];
        const r = await notifyOwner(ctx, orgId, {
          kind: rpc.kind,
          title: rpc.title ?? rpc.text.slice(0, 120),
          text: rpc.text,
          taskId: rpc.task,
          deskItemId: rpc.item,
          subject: key,
        });
        await ctx.pool.query(
          `INSERT INTO ceo_flags (org_id, flag, value, at) VALUES ($1,$2,'1',$3) ON CONFLICT DO NOTHING`,
          [orgId, `notify:${key}`, ctx.clock.now()],
        );
        return [true, { status: 'executed', message: r.emailed ? 'The owner was notified (desk and e-mail).' : 'The owner was notified.' }];
      }
      case 'task':
        return [true, await taskOp(ctx, env.agentId, orgId, rpc, origin)];
      case 'memory':
        return [true, await memoryOp(ctx, agent, orgId, rpc, origin)];
      default:
        return [false, undefined, 'unknown operation'];
    }
  } catch (err) {
    if (err instanceof HttpError) return [false, undefined, err.message];
    throw err;
  }
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
    const msgs = await rows(ctx.pool, `SELECT kind, body, author_kind, created_at FROM thread_messages WHERE thread_id=$1 ORDER BY created_at DESC LIMIT 6`, [c.id]);
    return [
      `${c.ref} id=${c.id} status=${c.status} stage=${c.stage} priority=${c.priority} rework=${c.rework_round} agent=${c.agent_name ?? '-'}${c.retry_after ? ` backoff_until=${new Date(c.retry_after).toISOString()}` : ''}`,
      renderUntrusted(`Card ${c.ref}`, `${c.title}\n\nRecent thread:\n${msgs.reverse().map((m) => `[${m.author_kind}/${m.kind}] ${String(m.body).slice(0, 500)}`).join('\n')}`),
    ].join('\n');
  }
  if (rpc.kind === 'agent') {
    const a = await one(ctx.pool, `SELECT * FROM agents WHERE org_id=$1 AND (lower(name)=lower($2) OR id::text=$2)`, [orgId, ref]);
    if (!a) return 'agent not found';
    const recent = await rows(ctx.pool, `SELECT kind, outcome, started_at FROM shifts WHERE agent_id=$1 ORDER BY started_at DESC LIMIT 8`, [a.id]);
    return `${a.name} id=${a.id} ${a.role_key}/${a.seniority} ${a.model} status=${a.status}${a.paused_at ? ' PAUSED' : ''}\nrecent shifts: ${recent.map((s) => `${s.kind}:${s.outcome ?? 'running'}`).join(', ') || 'none'}`;
  }
  if (rpc.kind === 'desk-item') {
    const d = await one(ctx.pool, `SELECT * FROM desk_items WHERE org_id=$1 AND id::text=$2`, [orgId, ref]);
    if (!d) return 'desk item not found';
    return [`item=${d.id} ${d.kind}${d.subkind ? `:${d.subkind}` : ''} status=${d.status}${d.blocking ? ' BLOCKING' : ''} options=${JSON.stringify(d.options)}`, renderUntrusted('Desk item', `${d.title}\n\n${d.body ?? ''}`)].join('\n');
  }
  if (rpc.kind === 'shift') {
    const s = await one(ctx.pool, `SELECT s.*, a.name FROM shifts s JOIN agents a ON a.id=s.agent_id WHERE s.org_id=$1 AND s.id::text=$2`, [orgId, ref]);
    return s ? `shift=${s.id} ${s.kind} agent=${s.name} status=${s.status} outcome=${s.outcome ?? '-'} started=${new Date(s.started_at).toISOString()}` : 'shift not found';
  }
  if (rpc.kind === 'project') {
    const p = await one(ctx.pool, `SELECT * FROM projects WHERE org_id=$1 AND (key=upper($2) OR id::text=$2)`, [orgId, ref]);
    return p ? `${p.key} id=${p.id} status=${p.status} budget=${p.budget_micros ?? 'none'}` : 'project not found';
  }
  const w = await one(ctx.pool, `SELECT * FROM workstations WHERE status='active' AND (lower(name)=lower($1) OR id::text=$1)`, [ref]);
  return w ? `${w.name} id=${w.id} connected=${w.connected} runner=${w.runner_version ?? '?'} runtimes=${JSON.stringify(w.runtimes)}` : 'workstation not found';
}

async function search(ctx: Ctx, orgId: string, rpc: Extract<CeoRpc, { op: 'search' }>): Promise<string> {
  const like = `%${rpc.q.replace(/[%_]/g, '')}%`;
  if (rpc.in === 'memory') {
    const m = await searchMemories(ctx, orgId, rpc.q);
    return m.map((x) => `memory:${x.id} [${x.kind}, ${Math.round(x.confidence * 100)}%] ${x.text}`).join('\n') || 'no memories match';
  }
  if (rpc.in === 'cards') {
    const c = await rows(ctx.pool, `SELECT ref, id, status, title FROM cards WHERE org_id=$1 AND title ILIKE $2 ORDER BY updated_at DESC LIMIT 10`, [orgId, like]);
    return c.length ? renderUntrusted('Cards', c.map((x) => `${x.ref} (${x.status}) ${x.title}`).join('\n')) : 'no cards match';
  }
  const d = await rows(ctx.pool, `SELECT id, kind, subkind, status, title FROM desk_items WHERE org_id=$1 AND title ILIKE $2 ORDER BY created_at DESC LIMIT 10`, [orgId, like]);
  return d.length ? renderUntrusted('Desk items', d.map((x) => `${x.id} ${x.kind}:${x.subkind ?? ''} ${x.status} ${x.title}`).join('\n')) : 'no desk items match';
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
    if (!origin.chatThreadId || origin.untrusted) return { status: 'refused', message: 'tasks are opened from the owner\'s chat, not from a wake' };
    if (!rpc.title) return { status: 'refused', message: 'a title is required' };
    const id = await createTask(ctx, orgId, {
      title: rpc.title,
      request: rpc.request,
      threadId: origin.chatThreadId,
      due: rpc.due,
      watch: rpc.watch,
      by: { kind: 'ceo', agentId },
    });
    return { status: 'executed', taskId: id, message: 'Task opened. Delegate it, link what you create with `task update --watch`, and mark it done when it is.' };
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
  if (rpc.sub === 'confirm') return { status: 'refused', message: 'only the owner confirms a memory (the Memory tab)' };
  if (!rpc.text) return { status: 'refused', message: 'give the rule with --text' };
  // Memories come from owner-authored sources only: the owner's chat, or the owner's own desk answer.
  if (origin.untrusted || !origin.chatThreadId)
    if (!(rpc.source?.startsWith('desk:') && !origin.untrusted))
      return { status: 'refused', message: 'a memory may only come from what the owner said in the CEO chat or answered on the desk' };
  let source: 'owner_statement' | 'owner_desk_answer' = 'owner_statement';
  let sourceRef = `chat:${origin.chatThreadId ?? ''}`;
  if (rpc.source?.startsWith('desk:')) {
    const id = rpc.source.slice(5);
    const d = await one(ctx.pool, `SELECT id, status, answered_by FROM desk_items WHERE id::text=$1 AND org_id=$2`, [id, orgId]);
    if (!d || d.status !== 'answered' || !d.answered_by)
      return { status: 'refused', message: 'that desk item was not answered by the owner' };
    source = 'owner_desk_answer';
    sourceRef = `desk:${id}`;
  } else if (!origin.chatThreadId) return { status: 'refused', message: 'the owner has to say it in the chat' };
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
  return { status: 'executed', memoryId: id, message: 'Remembered. It will be listed as "I noted" in the next report.' };
}

