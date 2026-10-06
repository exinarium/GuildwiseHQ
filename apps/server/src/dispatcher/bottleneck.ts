import { randomUUID } from 'node:crypto';
import { DESK_SUBKIND, streamId, TESTER_BOTTLENECK_MINUTES } from '@aom/shared';
import { orgScope, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';

const ONLINE_WINDOW_MS = 45_000;

/** Work the dispatcher does after claiming (docs/ARCHITECTURE.md section 9.5): unpark tester cards, bottleneck alert. */
export async function testingPass(ctx: Ctx): Promise<void> {
  try {
    await unparkPass(ctx);
    await testerBottleneckCheck(ctx);
  } catch (err) {
    ctx.log.error({ err }, 'testing pass failed');
  }
}

/** A tester card parked on a DevOps request returns to the Test queue once the request completed (or failed: the next check decides). */
export async function unparkPass(ctx: Ctx): Promise<number> {
  const parked = await rows(
    ctx.pool,
    `SELECT c.id, c.org_id, c.project_id, c.parked_request_id FROM cards c
       JOIN devops_requests r ON r.id = c.parked_request_id
      WHERE c.status='waiting' AND r.status IN ('done','failed')`,
  );
  for (const c of parked) {
    await withAppendTx(ctx.pool, async (tx) => {
      const cur = await tx.query(
        `SELECT 1 FROM cards WHERE id=$1 AND status='waiting' AND parked_request_id=$2 FOR UPDATE`,
        [c.id, c.parked_request_id],
      );
      if (cur.rowCount === 0) return;
      await ctx.store.append(
        [
          {
            streamId: streamId.card(c.id),
            event: {
              type: 'TestEnvironmentReady',
              payload: { cardId: c.id, requestId: c.parked_request_id },
            },
            actor: SYSTEM_ACTOR,
            scope: projectScope(c.org_id, c.project_id),
          },
        ],
        { tx },
      );
    });
  }
  return parked.length;
}

/**
 * E2E work waiting longer than 5 minutes while every tester is busy: one pinned desk alert per project with a
 * hire recommendation (only when testers exist). Resolved automatically once the tester queue of the project drained.
 */
export async function testerBottleneckCheck(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const cutoff = new Date(now.getTime() - TESTER_BOTTLENECK_MINUTES * 60_000);
  const onlineSince = new Date(now.getTime() - ONLINE_WINDOW_MS);

  const waiting = await rows(
    ctx.pool,
    `SELECT c.id, c.project_id, c.org_id, c.queued_at FROM cards c
       JOIN workflow_stages st ON st.workflow_version_id = c.workflow_version_id AND st.stage_id = c.stage
      WHERE c.status='queued' AND c.claim_id IS NULL AND st.kind='agent' AND st.claim_role='tester'
      ORDER BY c.queued_at`,
  );
  const byProject = new Map<string, typeof waiting>();
  for (const c of waiting) byProject.set(c.project_id, [...(byProject.get(c.project_id) ?? []), c]);

  const open = await rows(
    ctx.pool,
    `SELECT id, project_id, org_id FROM desk_items WHERE subkind=$1 AND status='open'`,
    [DESK_SUBKIND.testerBottleneck],
  );
  const openByProject = new Map(open.map((d) => [d.project_id as string, d]));

  // Auto-resolve: nothing waits for a tester any more.
  for (const d of open) {
    if (byProject.has(d.project_id)) continue;
    await withAppendTx(ctx.pool, async (tx) => {
      const still = await tx.query(`SELECT 1 FROM desk_items WHERE id=$1 AND status='open' FOR UPDATE`, [
        d.id,
      ]);
      if (still.rowCount === 0) return;
      await ctx.store.append(
        [
          {
            streamId: streamId.desk(d.id),
            event: {
              type: 'DeskItemResolved',
              payload: {
                deskItemId: d.id,
                resolution: 'acknowledged',
                note: 'The tester queue drained.',
                by: { kind: 'system' },
              },
            },
            actor: SYSTEM_ACTOR,
            scope: d.project_id ? projectScope(d.org_id, d.project_id) : orgScope(d.org_id),
          },
        ],
        { tx },
      );
    });
  }

  for (const [projectId, cards] of byProject) {
    if (openByProject.has(projectId)) continue;
    const overdue = cards.filter((c) => c.queued_at && new Date(c.queued_at) < cutoff);
    if (overdue.length === 0) continue;
    const first = overdue[0] as { org_id: string };
    const testers = await rows(
      ctx.pool,
      `SELECT a.id, ws.connected AND ws.last_seen_at > $3 AS online,
              (SELECT count(*)::int FROM cards c WHERE c.claimed_by_agent_id = a.id AND c.claim_id IS NOT NULL) AS active,
              a.capacity
         FROM agents a LEFT JOIN workstations ws ON ws.id = a.workstation_id
        WHERE a.status='active' AND a.role_key='tester' AND NOT a.is_devops
          AND a.org_id = $2 AND (a.allowed_project_ids IS NULL OR $1::uuid = ANY (a.allowed_project_ids))
          AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $1::uuid AND pm.user_id = ws.user_id
                       AND pm.status = 'active')`,
      [projectId, first.org_id, onlineSince],
    );
    // Spec: "all testers are busy". A project that never hired a tester has no tester pool to be a bottleneck of.
    if (testers.length === 0) continue;
    const free = testers.some((t) => t.online && Number(t.active) < Number(t.capacity));
    if (free) continue;
    const busy = testers.filter((t) => Number(t.active) >= Number(t.capacity)).map((t) => t.id as string);
    const deskItemId = randomUUID();
    const scope = projectScope(first.org_id, projectId);
    const events: AppendInput[] = [
      {
        streamId: streamId.project(projectId),
        event: {
          type: 'TesterBottleneck',
          payload: {
            projectId,
            deskItemId,
            waitingCardIds: overdue.map((c) => c.id as string),
            busyTesterIds: busy,
            recommendation: { hire: 'tester', count: 1 },
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'alert',
            subkind: DESK_SUBKIND.testerBottleneck,
            title: `${overdue.length} card${overdue.length === 1 ? '' : 's'} waiting for a tester for over ${TESTER_BOTTLENECK_MINUTES} minutes`,
            body: `All ${testers.length} tester${testers.length === 1 ? ' is' : 's are'} busy or offline. Hiring one more tester clears the E2E queue sooner.`,
            options: [{ id: 'hire_tester', label: 'Hire a tester' }],
            recommendation: 'hire_tester',
            blocking: false,
            pinned: true,
            projectId,
            affectedCardIds: overdue.map((c) => c.id as string),
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
    ];
    await withAppendTx(ctx.pool, async (tx) => {
      const dup = await tx.query(
        `SELECT 1 FROM desk_items WHERE subkind=$1 AND project_id=$2 AND status='open'`,
        [DESK_SUBKIND.testerBottleneck, projectId],
      );
      if (dup.rowCount) return;
      await ctx.store.append(events, { tx });
    });
  }
}
