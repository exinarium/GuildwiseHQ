import { randomUUID } from 'node:crypto';
import { type CeoTaskStatus, streamId } from '@aom/shared';
import { agentActor, orgScope, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import { notifyOwner } from './notify.ts';
import { loadCeo } from './state.ts';

export interface CeoTaskDto {
  id: string;
  title: string;
  request: string;
  status: CeoTaskStatus;
  threadId: string | null;
  dueAt: string | null;
  watch: Array<{ kind: string; id: string }>;
  notes: Array<{ at: string; by: string; note: string }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

export const toTaskDto = (r: Row): CeoTaskDto => ({
  id: r.id,
  title: r.title,
  request: r.request,
  status: r.status,
  threadId: r.thread_id ?? null,
  dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
  watch: r.watch ?? [],
  notes: r.notes ?? [],
  createdBy: r.created_by,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
  doneAt: r.done_at ? new Date(r.done_at).toISOString() : null,
});

export async function listTasks(ctx: Ctx, orgId: string, openOnly = false): Promise<CeoTaskDto[]> {
  const list = await rows(
    ctx.pool,
    `SELECT * FROM ceo_tasks WHERE org_id=$1 AND ($2::boolean IS NOT TRUE OR status IN ('open','in_progress','waiting_owner','waiting_work'))
      ORDER BY (status IN ('done','failed','cancelled')), created_at DESC LIMIT 100`,
    [orgId, openOnly],
  );
  return list.map(toTaskDto);
}

export async function createTask(
  ctx: Ctx,
  orgId: string,
  input: {
    title: string;
    request?: string | undefined;
    threadId?: string | undefined;
    due?: string | undefined;
    watch?: Array<{ kind: 'card' | 'devops' | 'desk' | 'agent'; id: string }> | undefined;
    by: { kind: 'ceo'; agentId: string } | { kind: 'owner'; userId: string };
  },
): Promise<string> {
  const taskId = randomUUID();
  await ctx.store.append([
    {
      streamId: streamId.ceoTask(taskId),
      event: {
        type: 'CeoTaskCreated',
        payload: {
          taskId,
          orgId,
          title: input.title,
          request: input.request ?? '',
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.due ? { due: input.due } : {}),
          watch: input.watch ?? [],
          by: input.by.kind,
          ...(input.by.kind === 'owner' ? { byUserId: input.by.userId } : {}),
        },
      },
      actor: input.by.kind === 'ceo' ? agentActor(input.by.agentId) : userActor(input.by.userId),
      scope: orgScope(orgId),
    },
  ]);
  return taskId;
}

export async function updateTask(
  ctx: Ctx,
  orgId: string,
  taskId: string,
  patch: {
    status?: CeoTaskStatus | undefined;
    note?: string | undefined;
    title?: string | undefined;
    watch?: Array<{ kind: 'card' | 'devops' | 'desk' | 'agent'; id: string }> | undefined;
    due?: string | null | undefined;
  },
  by: 'ceo' | 'owner' | 'system',
  actor: { kind: 'agent'; id: string } | { kind: 'user'; id: string } | { kind: 'system'; id: null },
): Promise<void> {
  const cur = await one(ctx.pool, 'SELECT * FROM ceo_tasks WHERE id=$1 AND org_id=$2', [taskId, orgId]);
  if (!cur) throw notFound('task not found');
  await ctx.store.append([
    {
      streamId: streamId.ceoTask(taskId),
      event: {
        type: 'CeoTaskUpdated',
        payload: {
          taskId,
          orgId,
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.note ? { note: patch.note } : {}),
          ...(patch.title ? { title: patch.title } : {}),
          ...(patch.watch ? { watch: patch.watch } : {}),
          ...(patch.due !== undefined ? { due: patch.due } : {}),
          by,
        },
      },
      actor,
      scope: orgScope(orgId),
    },
  ]);
  // A finished task tells the owner (once).
  if (patch.status === 'done' && cur.status !== 'done') {
    const ceo = await loadCeo(ctx.pool, orgId);
    if (ceo)
      await notifyOwner(ctx, orgId, {
        kind: 'task_done',
        title: `Done: ${String(cur.title).slice(0, 150)}`,
        text: patch.note ?? `The task "${cur.title}" is done.`,
        taskId,
        subject: `task:${taskId}`,
      });
  }
}
