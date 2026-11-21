import { randomUUID } from 'node:crypto';
import {
  DESK_SUBKIND,
  type DevopsAuditCount,
  type DevopsCommandLogEntry,
  type RunnerErrorSummary,
  type RunnerToServerOf,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgScope, SYSTEM_ACTOR } from './common.ts';

/**
 * What the runner reports about itself (runner 0.1.24): unhandled errors (deduped by signature, a counter per
 * signature), the DevOps command audit trail and the result of the role smoke test. These are operational records,
 * not domain events: nothing replays from them, so they are plain tables (migration 2180).
 */

interface WsRef {
  id: string;
  userId: string;
}

/** `runner.error`: one row per signature; a repeat counts up and notes the workstation and version. */
export async function applyRunnerError(
  tx: Tx,
  ws: WsRef,
  msg: RunnerToServerOf<'runner.error'>,
  now: Date,
): Promise<void> {
  await exec(
    tx,
    `INSERT INTO runner_errors (signature, message, stack, context, first_version, last_version, last_workstation_id,
                                first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$7)
     ON CONFLICT (signature) DO UPDATE SET occurrences = runner_errors.occurrences + 1,
       last_seen_at = EXCLUDED.last_seen_at, last_version = EXCLUDED.last_version,
       last_workstation_id = EXCLUDED.last_workstation_id,
       stack = COALESCE(EXCLUDED.stack, runner_errors.stack)`,
    [msg.signature, msg.message, msg.stack ?? null, msg.context ?? null, msg.version, ws.id, now],
  );
  await exec(
    tx,
    `INSERT INTO runner_error_workstations (signature, workstation_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [msg.signature, ws.id],
  );
  await exec(
    tx,
    `UPDATE runner_errors SET workstation_count =
       (SELECT count(*)::int FROM runner_error_workstations WHERE signature=$1) WHERE signature=$1`,
    [msg.signature],
  );
}

export interface RunnerErrorRow {
  signature: string;
  message: string;
  stack: string | null;
  context: string | null;
  firstVersion: string;
  lastVersion: string;
  workstationCount: number;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  bugCardId: string | null;
}

/** The stored runner errors, most recent first (the platform team's bug intake reads this). */
export async function listRunnerErrors(ctx: Ctx, limit = 100): Promise<RunnerErrorRow[]> {
  const r = await rows(ctx.pool, 'SELECT * FROM runner_errors ORDER BY last_seen_at DESC LIMIT $1', [
    Math.min(Math.max(1, Math.floor(limit)), 500),
  ]);
  return r.map((x: Row) => ({
    signature: x.signature,
    message: x.message,
    stack: x.stack,
    context: x.context,
    firstVersion: x.first_version,
    lastVersion: x.last_version,
    workstationCount: x.workstation_count,
    occurrences: x.occurrences,
    firstSeenAt: new Date(x.first_seen_at).toISOString(),
    lastSeenAt: new Date(x.last_seen_at).toISOString(),
    bugCardId: x.bug_card_id,
  }));
}

/** `devops.audit`: appends the batch of commands the guard hook saw. */
export async function applyDevopsAudit(
  tx: Tx,
  ws: WsRef,
  msg: RunnerToServerOf<'devops.audit'>,
): Promise<void> {
  for (const e of msg.entries) {
    await exec(
      tx,
      `INSERT INTO devops_audit (workstation_id, at, session_ref, kind, shift_kind, decision, rule, command)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ws.id, e.at, e.sessionRef, e.kind, e.shiftKind ?? null, e.decision, e.rule, e.command],
    );
  }
}

/** Every DevOps command row, unscoped: internal use and tests only. No route returns it (R17-4: see below). */
export async function listDevopsAudit(
  ctx: Ctx,
  opts: { workstationId?: string; refusedOnly?: boolean; limit?: number } = {},
): Promise<Row[]> {
  return rows(
    ctx.pool,
    `SELECT id, workstation_id, at, session_ref, kind, shift_kind, decision, rule, command FROM devops_audit
      WHERE ($1::uuid IS NULL OR workstation_id=$1) AND (NOT $2 OR decision='refused')
      ORDER BY at DESC, id DESC LIMIT $3`,
    [opts.workstationId ?? null, opts.refusedOnly ?? false, Math.min(Math.max(1, opts.limit ?? 100), 1000)],
  );
}

/** Roles blocked on a workstation by a failed smoke test (the dispatcher skips their agents there). */
export async function blockedRoles(ctx: Ctx): Promise<Set<string>> {
  const r = await rows<{ workstation_id: string; role_key: string }>(
    ctx.pool,
    'SELECT workstation_id, role_key FROM workstation_role_blocks',
  );
  return new Set(r.map((x) => `${x.workstation_id}|${x.role_key}`));
}

/**
 * `role.smoke`: replaces the workstation's blocks with the roles that failed this time, and raises ONE desk alert per
 * workstation and organisation while any role is blocked (closed when all pass again).
 */
export async function applyRoleSmoke(
  ctx: Ctx,
  ws: WsRef,
  msg: RunnerToServerOf<'role.smoke'>,
): Promise<void> {
  const failed = msg.results.filter((r) => !r.ok);
  const w = await one<{ name: string }>(ctx.pool, 'SELECT name FROM workstations WHERE id=$1', [ws.id]);
  if (!w) return;
  await withAppendTx(ctx.pool, async (tx) => {
    await exec(tx, 'DELETE FROM workstation_role_blocks WHERE workstation_id=$1', [ws.id]);
    for (const f of failed)
      await exec(
        tx,
        `INSERT INTO workstation_role_blocks (workstation_id, role_key, detail, runner_version, checked_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [ws.id, f.roleKey, f.detail ?? null, msg.runnerVersion, ctx.clock.now()],
      );
    const key = `role_smoke:${ws.id}`;
    const open = await rows<{ id: string; org_id: string }>(
      tx,
      `SELECT id, org_id FROM desk_items WHERE subkind=$1 AND status='open' AND data->>'key'=$2`,
      [DESK_SUBKIND.roleSmokeFailed, key],
    );
    const events: AppendInput[] = [];
    if (failed.length > 0) {
      const orgs = (
        await rows<{ org_id: string }>(
          tx,
          `SELECT DISTINCT org_id FROM agents WHERE workstation_id=$1 AND status='active' AND role_key = ANY($2)`,
          [ws.id, failed.map((f) => f.roleKey)],
        )
      ).map((r) => r.org_id);
      const detail = failed.map((f) => `${f.roleKey}: ${f.detail ?? 'failed'}`).join('; ');
      for (const orgId of orgs) {
        const existing = open.find((o) => o.org_id === orgId);
        if (existing) continue;
        const deskItemId = randomUUID();
        events.push({
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'alert',
              subkind: DESK_SUBKIND.roleSmokeFailed,
              title: `${failed.map((f) => f.roleKey).join(', ')} cannot work on ${w.name}`,
              body: `The runner's self-test of ${failed.length === 1 ? 'this role' : 'these roles'} failed on ${w.name} (runner ${msg.runnerVersion}): ${detail}. Those agents get no work on this workstation until the next self-test passes (it runs when the runner starts and after every update).`,
              options: [],
              blocking: false,
              pinned: false,
              affectedCardIds: [],
              askedBy: { kind: 'system' },
              addresseeUserId: ws.userId,
              data: { key, workstationId: ws.id },
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(orgId),
        });
      }
    } else {
      for (const o of open)
        events.push({
          streamId: streamId.desk(o.id),
          event: {
            type: 'DeskItemResolved',
            payload: {
              deskItemId: o.id,
              resolution: 'acknowledged',
              note: 'Fixed: the role self-test passes again.',
              by: { kind: 'system' },
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(o.org_id),
        });
    }
    if (events.length > 0) await ctx.store.append(events, { tx });
  });
}

// ------------------------------------------------------------------------------- R17-4: who sees what of it

/**
 * A stack frame the platform may see: `at name (module:line:col)` (or without a name), where the module is a path the
 * runner ships (`src/…`, `dist/…`, `node:…`), reduced to that tail. Anything else (a message, a user path, a host name,
 * a command) is dropped.
 */
const FRAME =
  /^\s*at\s+(?:((?:async\s)?[\w$.<>[\]]{1,120})\s+\()?(?:file:\/\/)?(?:[^()\s]*?\/)?((?:src|dist)\/[\w./-]{1,200}|node:[\w/]{1,60}):(\d{1,6}):(\d{1,6})\)?\s*$/;

export function safeTopFrames(stack: string | null | undefined, max = 5): string[] {
  const out: string[] = [];
  for (const line of (stack ?? '').split('\n')) {
    const m = FRAME.exec(line);
    if (!m) continue;
    out.push(`at ${m[1] ? `${m[1]} ` : ''}(${m[2]}:${m[3]}:${m[4]})`);
    if (out.length >= max) break;
  }
  return out;
}

/** The platform's view of the runner errors (R17-4): no message, no stack, no context; checked frames only. */
export async function listRunnerErrorSummaries(ctx: Ctx, limit = 100): Promise<RunnerErrorSummary[]> {
  return (await listRunnerErrors(ctx, limit)).map((e) => ({
    signature: e.signature,
    firstVersion: e.firstVersion,
    lastVersion: e.lastVersion,
    workstationCount: e.workstationCount,
    occurrences: e.occurrences,
    firstSeenAt: e.firstSeenAt,
    lastSeenAt: e.lastSeenAt,
    topFrames: safeTopFrames(e.stack),
  }));
}

/** The platform's view of the DevOps audit (R17-4): counts per runner version and platform, never a command. */
export async function devopsAuditCounts(ctx: Ctx): Promise<DevopsAuditCount[]> {
  const r = await rows(
    ctx.pool,
    `SELECT w.runner_version, w.platform, count(*)::int AS total,
            count(*) FILTER (WHERE a.decision = 'refused')::int AS refused,
            count(DISTINCT a.workstation_id)::int AS workstations
       FROM devops_audit a LEFT JOIN workstations w ON w.id = a.workstation_id
      GROUP BY w.runner_version, w.platform
      ORDER BY total DESC, w.runner_version NULLS LAST, w.platform NULLS LAST`,
  );
  return r.map((x) => ({
    runnerVersion: x.runner_version ?? null,
    platform: x.platform ?? null,
    total: x.total,
    refused: x.refused,
    workstations: x.workstations,
  }));
}

const auditEntry = (r: Row): DevopsCommandLogEntry => ({
  id: String(r.id),
  workstationId: r.workstation_id,
  workstationName: r.workstation_name ?? null,
  at: new Date(r.at).toISOString(),
  kind: r.kind,
  shiftKind: r.shift_kind ?? null,
  decision: r.decision,
  rule: r.rule ?? null,
  command: r.command,
});

/**
 * The full DevOps command log of one organization, for its Owner: the commands of DevOps shifts of that organization
 * (`session_ref` is the shift id). Chat sessions carry no organization and show only on the workstation's own log.
 */
export async function orgDevopsAudit(
  ctx: Ctx,
  orgId: string,
  opts: { limit?: number; refusedOnly?: boolean } = {},
): Promise<DevopsCommandLogEntry[]> {
  const r = await rows(
    ctx.pool,
    `SELECT a.*, w.name AS workstation_name FROM devops_audit a
       JOIN shifts s ON s.id::text = a.session_ref AND s.org_id = $1
       LEFT JOIN workstations w ON w.id = a.workstation_id
      WHERE a.kind = 'shift' AND (NOT $2 OR a.decision = 'refused')
      ORDER BY a.at DESC, a.id DESC LIMIT $3`,
    [orgId, opts.refusedOnly ?? false, Math.min(Math.max(1, opts.limit ?? 100), 500)],
  );
  return r.map(auditEntry);
}

/** The full DevOps command log of one workstation, for its owner (shifts of every organization, and chats). */
export async function workstationDevopsAudit(
  ctx: Ctx,
  workstationId: string,
  opts: { limit?: number; refusedOnly?: boolean } = {},
): Promise<DevopsCommandLogEntry[]> {
  const r = await rows(
    ctx.pool,
    `SELECT a.*, w.name AS workstation_name FROM devops_audit a LEFT JOIN workstations w ON w.id = a.workstation_id
      WHERE a.workstation_id = $1 AND (NOT $2 OR a.decision = 'refused')
      ORDER BY a.at DESC, a.id DESC LIMIT $3`,
    [workstationId, opts.refusedOnly ?? false, Math.min(Math.max(1, opts.limit ?? 100), 500)],
  );
  return r.map(auditEntry);
}
