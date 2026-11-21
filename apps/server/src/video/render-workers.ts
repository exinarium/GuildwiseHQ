import { randomUUID } from 'node:crypto';
import {
  RENDER_WORKER_TOKEN_PREFIX,
  type RenderEncoder,
  type RenderWorker,
  type RenderWorkerHealth,
  streamId,
} from '@aom/shared';
import { notifySuperAdmins } from '../commands/platform-notify.ts';
import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { exec, iso, one, type Row, rows } from '../db/sql.ts';
import { notFound } from '../errors.ts';

/**
 * Render workers (core DESIGN R16, R23): platform-level machines (the DevBox GPU worker) that render through the job API
 * with their own token `aomv_<32 bytes>`. Only the sha256 is stored (projection of `RenderWorkerAdded` /
 * `RenderWorkerRevoked`); revoking stops the token on its next request. `last_*`, `version` and `encoder*` are updated
 * directly. A worker on the CPU (no NVENC, or a fallback at run time) is never silent: a badge on the card, an entry in
 * the video status and one mail to the super admins per worker per 24 h.
 */

const DAY_MS = 86_400_000;
/** "No render worker seen for 30 min while renders wait" (R23). */
export const RENDER_WORKER_SILENT_MS = 30 * 60_000;
const LOG_KEEP_MS = 90 * DAY_MS;
const SCOPE = { orgId: null, projectId: null, audience: 'admin' } as const;

export const tokenHashOf = (token: string): string => sha256Hex(token);

function toWorker(r: Row): RenderWorker {
  return {
    id: r.id,
    name: r.name,
    createdAt: iso(r.created_at) as string,
    revokedAt: iso(r.revoked_at),
    lastSeenAt: iso(r.last_seen_at),
    lastIp: r.last_ip ?? null,
    version: r.version ?? null,
    encoder: r.encoder ?? null,
    encoderReason: r.encoder_reason ?? null,
    warning: !r.revoked_at && r.encoder === 'cpu',
  };
}

export async function listRenderWorkers(ctx: Ctx): Promise<RenderWorker[]> {
  return (
    await rows(ctx.pool, `SELECT * FROM render_workers ORDER BY revoked_at NULLS FIRST, created_at`)
  ).map(toWorker);
}

/** Adds a worker; the token is returned once and never stored. */
export async function addRenderWorker(
  ctx: Ctx,
  by: string,
  name: string,
): Promise<{ worker: RenderWorker; token: string }> {
  const workerId = randomUUID();
  const token = `${RENDER_WORKER_TOKEN_PREFIX}${randomToken(32)}`;
  await ctx.store.append([
    {
      streamId: streamId.renderWorker(workerId),
      event: { type: 'RenderWorkerAdded', payload: { workerId, name, tokenHash: tokenHashOf(token), by } },
      actor: { kind: 'user', id: by },
      scope: SCOPE,
    },
  ]);
  const row = await one(ctx.pool, 'SELECT * FROM render_workers WHERE id=$1', [workerId]);
  return { worker: toWorker(row as Row), token };
}

export async function revokeRenderWorker(ctx: Ctx, by: string, workerId: string): Promise<RenderWorker> {
  const row = await one(ctx.pool, 'SELECT * FROM render_workers WHERE id=$1', [workerId]);
  if (!row) throw notFound('render worker not found');
  if (!row.revoked_at)
    await ctx.store.append([
      {
        streamId: streamId.renderWorker(workerId),
        event: { type: 'RenderWorkerRevoked', payload: { workerId, by } },
        actor: { kind: 'user', id: by },
        scope: SCOPE,
      },
    ]);
  return toWorker((await one(ctx.pool, 'SELECT * FROM render_workers WHERE id=$1', [workerId])) as Row);
}

/** The worker a bearer token belongs to (one unique-index lookup), or null for an unknown or revoked token. */
export async function workerByToken(ctx: Ctx, token: string | undefined): Promise<Row | null> {
  if (!token?.startsWith(RENDER_WORKER_TOKEN_PREFIX)) return null;
  const r = await one(ctx.pool, 'SELECT * FROM render_workers WHERE token_hash=$1', [tokenHashOf(token)]);
  return r && !r.revoked_at ? r : null;
}

/** How often one kind of denial from one caller is written to the log (the rest of the window is only counted). */
export const DENIAL_LOG_WINDOW_MS = 60_000;
const lastDenial = new Map<string, number>();

/**
 * A denied request, logged at most once per caller (worker or address), action and outcome per minute, so a flood of
 * bad requests cannot grow the table (review blocker 1). Callers check their rate limits before calling this. Returns
 * whether a row was written.
 */
export async function logDenied(
  ctx: Ctx,
  e: {
    workerId: string | null;
    action: string;
    renderId?: string | null;
    ip?: string | null;
    outcome: string;
  },
): Promise<boolean> {
  const now = ctx.clock.now().getTime();
  const key = `${e.workerId ?? `ip:${e.ip ?? '-'}`}|${e.action}|${e.outcome}`;
  const last = lastDenial.get(key);
  if (last !== undefined && now - last < DENIAL_LOG_WINDOW_MS) return false;
  if (lastDenial.size > 10_000)
    for (const [k, t] of lastDenial) if (now - t >= DENIAL_LOG_WINDOW_MS) lastDenial.delete(k);
  if (lastDenial.size > 10_000) return false; // still full of fresh keys: count, do not write
  lastDenial.set(key, now);
  await logWorker(ctx, e);
  return true;
}

/** One row of the operational log (claims, encoder changes, completes, fails and denied requests). */
export async function logWorker(
  ctx: Ctx,
  e: {
    workerId: string | null;
    action: string;
    renderId?: string | null;
    ip?: string | null;
    outcome: string;
  },
): Promise<void> {
  await exec(
    ctx.pool,
    `INSERT INTO render_worker_log (at, worker_id, action, render_id, ip, outcome) VALUES ($1,$2,$3,$4,$5,$6)`,
    [ctx.clock.now(), e.workerId, e.action, e.renderId ?? null, e.ip ?? null, e.outcome.slice(0, 480)],
  );
}

/** Records that the worker was seen (every authenticated request). */
export async function touchWorker(
  ctx: Ctx,
  workerId: string,
  seen: { ip: string | null; version?: string | null },
): Promise<void> {
  await exec(
    ctx.pool,
    `UPDATE render_workers SET last_seen_at=$2, last_ip=$3, version=COALESCE($4, version) WHERE id=$1`,
    [workerId, ctx.clock.now(), seen.ip, seen.version ?? null],
  );
}

/**
 * The encoder a worker reports with a claim or heartbeat, or a render that fell back (`fallback`). A change is logged;
 * `cpu` (whatever the cause) sets the badge and mails the super admins at most once per worker per 24 h. A `cpu` report
 * from a worker that last reported `nvenc` counts as a fallback too.
 */
export async function reportEncoder(
  ctx: Ctx,
  worker: Row,
  encoder: RenderEncoder,
  reason: string | null | undefined,
  opts: { ip?: string | null; renderId?: string | null; fallback?: boolean } = {},
): Promise<void> {
  const why = encoder === 'cpu' ? (reason?.trim() || 'no reason given').slice(0, 480) : null;
  const before = {
    encoder: worker.encoder as RenderEncoder | null,
    reason: worker.encoder_reason as string | null,
  };
  if (before.encoder === encoder && before.reason === why) return;
  await exec(ctx.pool, `UPDATE render_workers SET encoder=$2, encoder_reason=$3 WHERE id=$1`, [
    worker.id,
    encoder,
    why,
  ]);
  worker.encoder = encoder;
  worker.encoder_reason = why;
  const fallback = opts.fallback || (encoder === 'cpu' && before.encoder === 'nvenc');
  await logWorker(ctx, {
    workerId: worker.id,
    action: 'encoder',
    renderId: opts.renderId ?? null,
    ip: opts.ip ?? null,
    outcome: encoder === 'cpu' ? `${fallback ? 'fallback to cpu' : 'cpu'}: ${why}` : 'nvenc',
  });
  if (encoder === 'cpu') {
    ctx.log.warn(
      { workerId: worker.id, reason: why, fallback },
      `render worker ${worker.name} renders on the CPU`,
    );
    await mailCpuOnce(ctx, worker, why as string, fallback);
  }
}

/** At most one "renders on the CPU" mail per worker per 24 h (the claim is a row in the platform settings). */
async function mailCpuOnce(ctx: Ctx, worker: Row, reason: string, fallback: boolean): Promise<boolean> {
  const now = ctx.clock.now();
  const claimed = await exec(
    ctx.pool,
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, NULL, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
       WHERE platform_settings.updated_at <= $4`,
    [
      `render_worker_cpu_mail:${worker.id}`,
      JSON.stringify({ reason }),
      now,
      new Date(now.getTime() - DAY_MS),
    ],
  );
  if (!claimed) return false;
  await notifySuperAdmins(ctx, {
    subject: `Render worker ${worker.name} renders on the CPU`,
    heading: `Render worker ${worker.name} renders on the CPU: ${reason}`,
    facts: [
      ['Worker', worker.name],
      [
        'What happened',
        fallback ? 'NVENC stopped working; renders continue on the CPU' : 'NVENC is not available',
      ],
      ['Reason', reason],
    ],
    path: '/platform/video',
    linkLabel: 'Open Platform > Video',
  });
  return true;
}

/** The health entries of the workers that are not revoked (video status `renderWorkers`). */
export async function renderWorkerHealth(ctx: Ctx): Promise<RenderWorkerHealth[]> {
  const workers: RenderWorkerHealth[] = (
    await rows(ctx.pool, `SELECT * FROM render_workers WHERE revoked_at IS NULL ORDER BY created_at`)
  ).map((r) => ({
    name: r.name,
    encoder: r.encoder ?? null,
    reason: r.encoder_reason ?? null,
    lastSeen: iso(r.last_seen_at),
    warning: r.encoder === 'cpu',
  }));
  // an emergency render on the server in the last 24 h counts as a CPU fallback (owner: never silent)
  const server = await one(ctx.pool, `SELECT value, updated_at FROM platform_settings WHERE key=$1`, [
    SERVER_RENDER_KEY,
  ]);
  if (server && ctx.clock.now().getTime() - new Date(server.updated_at).getTime() < DAY_MS)
    workers.push({
      name: SERVER_RENDER_NAME,
      encoder: 'cpu',
      reason: String(server.value?.reason ?? SERVER_RENDER_REASON),
      lastSeen: iso(server.updated_at),
      warning: true,
    });
  return workers;
}

const SERVER_RENDER_KEY = 'render_server_fallback';
/** How the server's own (in-process) renderer appears in the video status and the mail. */
export const SERVER_RENDER_NAME = 'server (emergency in-process render)';
const SERVER_RENDER_REASON =
  'AOM_ALLOW_SERVER_RENDER is on: the server renders on its CPU because no GPU render worker does';

/**
 * Coordinator decision (GPU is the production path; a fallback is never silent): when the in-process renderer runs
 * with `AOM_ALLOW_SERVER_RENDER=true` (the hosting layer's emergency switch, read from the raw environment), each claim
 * is reported like a CPU fallback: an entry with the warning in the video status for 24 h, and the same mail at most
 * once a day. Self-hosters rendering in-process without the switch are not reported (that is their normal path).
 */
export async function reportServerRender(ctx: Ctx, renderId: string): Promise<boolean> {
  if (ctx.config.env?.AOM_ALLOW_SERVER_RENDER !== 'true') return false;
  await exec(
    ctx.pool,
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, NULL, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [SERVER_RENDER_KEY, JSON.stringify({ reason: SERVER_RENDER_REASON, renderId }), ctx.clock.now()],
  );
  ctx.log.warn({ renderId }, `${SERVER_RENDER_NAME}: ${SERVER_RENDER_REASON}`);
  await mailCpuOnce(ctx, { id: 'server', name: SERVER_RENDER_NAME }, SERVER_RENDER_REASON, true);
  return true;
}

/**
 * Runs with the video watch (the app's scheduler, DB only): prunes the worker log after 90 days, and mails "no render
 * worker seen for 30 min while renders wait" (at most once per 24 h) when render workers exist and none reported in.
 */
export async function renderWorkerWatch(ctx: Ctx): Promise<{ alerted: boolean }> {
  const now = ctx.clock.now();
  await exec(ctx.pool, 'DELETE FROM render_worker_log WHERE at < $1', [
    new Date(now.getTime() - LOG_KEEP_MS),
  ]);
  const workers = await one(
    ctx.pool,
    `SELECT count(*)::int AS n, max(last_seen_at) AS seen FROM render_workers WHERE revoked_at IS NULL`,
  );
  if (!workers?.n) return { alerted: false };
  const seen = workers.seen ? new Date(workers.seen).getTime() : 0;
  if (now.getTime() - seen < RENDER_WORKER_SILENT_MS) return { alerted: false };
  const waiting = await one(
    ctx.pool,
    `SELECT count(*)::int AS n FROM video_renders x JOIN video_posts p ON p.id = x.post_id AND p.revision = x.revision
      WHERE NOT x.library AND x.status = 'queued' AND p.script IS NOT NULL
        AND ((p.status='approved' AND (x.not_before IS NULL OR x.not_before <= $1))
             OR (x.preview AND p.status IN ('draft','in_review')))`,
    [now],
  );
  if (!waiting?.n) return { alerted: false };
  const claimed = await exec(
    ctx.pool,
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ('render_worker_silent_mail', $1::jsonb, NULL, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
       WHERE platform_settings.updated_at <= $3`,
    [JSON.stringify({ waiting: waiting.n }), now, new Date(now.getTime() - DAY_MS)],
  );
  if (!claimed) return { alerted: false };
  await notifySuperAdmins(ctx, {
    subject: 'No render worker is running',
    heading: 'No render worker seen for 30 minutes while renders wait',
    facts: [
      ['Renders waiting', String(waiting.n)],
      ['Last seen', workers.seen ? new Date(workers.seen).toISOString() : 'never'],
      ['What to do', 'Start the render worker on the GPU machine (render-worker.sh status, then start)'],
    ],
    path: '/platform/video',
    linkLabel: 'Open Platform > Video',
  });
  return { alerted: true };
}
