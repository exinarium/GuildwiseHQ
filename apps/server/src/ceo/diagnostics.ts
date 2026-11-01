import {
  CEO_DIAGNOSTICS_CAPABILITY,
  CEO_FULL_POWER_CAPABILITY,
  DIAGNOSTICS_MAX_CHARS,
  maskSecrets,
  RUNNER_LOG_KINDS,
  type RunnerDiagnosticsRequest,
  RunnerDiagnosticsResultSchema,
  runnerAtLeast,
} from '@aom/shared';
import { orgOwnerId } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';

/** The first runner that answers `runner.diagnostics` (and has `aom runner logs|status`). */
export const MIN_RUNNER_FOR_CEO_DIAGNOSTICS = '0.1.65';
/** How long the command stays deliverable (the `aom` command collects its answer within about 40 seconds). */
const DIAG_COMMAND_TTL_MS = 2 * 60_000;

/**
 * Diagnostics for the CEO's full-power owner turn (docs/investigations/ceo-full-power.md). Read-only. Offered only when the
 * turn really runs with full power: the CEO's workstation belongs to the organization's Owner and announces the opt-in. A
 * restricted-profile turn (another user's machine, or the opt-in off) gets a refusal that says why.
 */
export async function fullPowerRefusal(ctx: Ctx, agent: Row, orgId: string): Promise<string | null> {
  const ws = await one(
    ctx.pool,
    `SELECT w.id, w.user_id, w.name, w.status FROM agents a JOIN workstations w ON w.id = a.workstation_id WHERE a.id=$1`,
    [agent.id],
  );
  if (!ws || ws.status !== 'active') return 'the CEO has no active workstation, so there is nothing to read';
  const ownerId = await orgOwnerId(ctx.pool, orgId);
  if (ws.user_id !== ownerId)
    return "diagnostics are part of full power, which runs on the Owner's own workstation only: this CEO runs on another user's machine";
  const caps = await one(
    ctx.pool,
    'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1',
    [ws.id],
  );
  if (!(caps?.capabilities ?? []).includes(CEO_FULL_POWER_CAPABILITY))
    return `full power is off on ${ws.name} (\`guildwise-runner ceo full-power on\`): diagnostics are part of full power`;
  return null;
}

const clip = (text: string): string =>
  text.length > DIAGNOSTICS_MAX_CHARS ? `…\n${text.slice(-DIAGNOSTICS_MAX_CHARS)}` : text;

/** `aom ceo diag server --kind status`: what an operator would look at first. */
export async function serverStatus(ctx: Ctx, orgId: string): Promise<string> {
  const started = Date.now();
  let db = 'ok';
  try {
    await ctx.pool.query('SELECT 1');
  } catch (err) {
    db = `failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  const ownerId = await orgOwnerId(ctx.pool, orgId);
  const stations = await rows(
    ctx.pool,
    `SELECT w.name, w.connected, w.runner_version, w.last_seen_at, w.hostname, w.platform,
            COALESCE(c.capabilities, '{}') AS caps
       FROM workstations w LEFT JOIN workstation_capabilities c ON c.workstation_id = w.id
      WHERE w.user_id=$1 AND w.status='active' ORDER BY w.name`,
    [ownerId],
  );
  const failed = await rows(
    ctx.pool,
    `SELECT type, count(*)::int AS n, max(last_error) AS last_error
       FROM runner_commands WHERE status='failed' AND created_at > now() - interval '24 hours'
      GROUP BY type ORDER BY n DESC LIMIT 10`,
  );
  const pending = await one(
    ctx.pool,
    `SELECT count(*)::int AS n FROM runner_commands WHERE status IN ('pending','sent')`,
  );
  const ring = ctx.logRing?.read({ lines: 5000, level: 'warn' }) ?? [];
  const errors = ring.filter((l) => /"level":(50|60)/.test(l)).length;
  const mem = process.memoryUsage();
  const status = {
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: { rss: Math.round(mem.rss / 1e6), heapUsed: Math.round(mem.heapUsed / 1e6) },
    database: db,
    databaseRoundTripMs: Date.now() - started,
    runnersConnected: ctx.services.runners.all().length,
    runnerCommandsWaiting: pending?.n ?? 0,
    failedRunnerCommandsLast24h: failed.map((f) => ({
      type: f.type,
      count: f.n,
      lastError: f.last_error ? String(f.last_error).slice(0, 200) : null,
    })),
    recentLog: { warnOrWorse: ring.length, errorOrWorse: errors, bufferedLines: ctx.logRing?.size ?? 0 },
    ownerWorkstations: stations.map((w) => ({
      name: w.name,
      connected: w.connected === true,
      runnerVersion: w.runner_version,
      lastSeenAt: w.last_seen_at,
      platform: w.platform,
      canAnswerDiagnostics:
        (w.caps as string[]).includes(CEO_DIAGNOSTICS_CAPABILITY) &&
        runnerAtLeast(w.runner_version, MIN_RUNNER_FOR_CEO_DIAGNOSTICS),
    })),
  };
  return maskSecrets(JSON.stringify(status, null, 2));
}

/** `aom ceo diag server --kind logs`: the newest log lines at or above a level, masked. */
export function serverLogs(
  ctx: Ctx,
  opts: { lines: number; level: 'debug' | 'info' | 'warn' | 'error'; grep?: string | undefined },
): string {
  if (!ctx.logRing) return 'This server keeps no recent log lines.';
  const lines = ctx.logRing.read(opts);
  return lines.length
    ? clip(lines.join('\n'))
    : `No log lines at ${opts.level} or above${opts.grep ? ` containing "${opts.grep}"` : ''} in the last ${ctx.logRing.size} buffered lines (the buffer starts when the server starts).`;
}

/** The Owner's workstation by name or id; a string is the refusal. */
async function resolveWorkstation(ctx: Ctx, orgId: string, ref: string): Promise<Row | string> {
  const ownerId = await orgOwnerId(ctx.pool, orgId);
  const list = await rows(
    ctx.pool,
    `SELECT w.id, w.name, w.connected, w.runner_version, COALESCE(c.capabilities, '{}') AS caps
       FROM workstations w LEFT JOIN workstation_capabilities c ON c.workstation_id = w.id
      WHERE w.user_id=$1 AND w.status='active'`,
    [ownerId],
  );
  const hit =
    list.find((w) => w.id === ref) ??
    list.find((w) => String(w.name).toLowerCase() === ref.toLowerCase()) ??
    (list.filter((w) => String(w.name).toLowerCase().includes(ref.toLowerCase())).length === 1
      ? list.find((w) => String(w.name).toLowerCase().includes(ref.toLowerCase()))
      : undefined);
  return (
    hit ??
    `no workstation of the Owner matches "${ref}" (they are: ${list.map((w) => w.name).join(', ') || 'none'})`
  );
}

/** What a call about a workstation's diagnostics answers: the text, or `pending` with the request to collect later. */
export type WorkstationDiagAnswer =
  | { text: string }
  | { status: 'pending'; requestId: string; message: string };

/**
 * `aom ceo diag workstation <name>`: asks the Owner's runner for its status or logs. The runner's answer takes seconds, and the
 * gateway handles a runner's messages one after the other, so this call must not wait for it (the answer would queue behind
 * this very call): it returns the request, and the `aom` command collects the answer with `requestId`.
 */
export async function startWorkstationDiagnostics(
  ctx: Ctx,
  orgId: string,
  ref: string,
  request: Partial<RunnerDiagnosticsRequest>,
): Promise<WorkstationDiagAnswer> {
  const kind = request.kind ?? 'runner';
  if (!(RUNNER_LOG_KINDS as readonly string[]).includes(kind))
    return { text: `unknown kind "${kind}": ${RUNNER_LOG_KINDS.join(', ')}` };
  const ws = await resolveWorkstation(ctx, orgId, ref);
  if (typeof ws === 'string') return { text: ws };
  if (!ws.connected)
    return {
      text: `${ws.name} is offline: its runner can only be asked while it is connected. The runner's own logs stay on that machine.`,
    };
  if (
    !runnerAtLeast(ws.runner_version, MIN_RUNNER_FOR_CEO_DIAGNOSTICS) ||
    !ws.caps.includes(CEO_DIAGNOSTICS_CAPABILITY)
  )
    return {
      text: `the runner on ${ws.name} (${ws.runner_version ?? 'unknown version'}) is older than ${MIN_RUNNER_FOR_CEO_DIAGNOSTICS} and cannot show its logs remotely. Update it (Workstations, Check for updates); \`aom runner logs\` on the CEO's own machine works once it is updated.`,
    };
  const requestId = await enqueueRunnerCommand(
    ctx.pool,
    ws.id,
    'runner.diagnostics',
    {
      kind,
      ...(request.lines ? { lines: request.lines } : {}),
      ...(request.grep ? { grep: request.grep } : {}),
      ...(request.name ? { name: request.name } : {}),
      ...(request.since ? { since: request.since } : {}),
    },
    new Date(ctx.clock.now().getTime() + DIAG_COMMAND_TTL_MS),
  );
  void Promise.resolve(ctx.services.gateway.deliverPending(ws.id)).catch(() => undefined);
  return { status: 'pending', requestId, message: `asked ${ws.name}; collecting its answer` };
}

/** Collects the answer of a request started by `startWorkstationDiagnostics` (read once: the stored text is cleared). */
export async function collectWorkstationDiagnostics(
  ctx: Ctx,
  orgId: string,
  requestId: string,
): Promise<WorkstationDiagAnswer> {
  const ownerId = await orgOwnerId(ctx.pool, orgId);
  const r = await one(
    ctx.pool,
    `SELECT c.status, c.result, c.last_error, w.name FROM runner_commands c JOIN workstations w ON w.id = c.workstation_id
      WHERE c.id=$1 AND c.type='runner.diagnostics' AND w.user_id=$2`,
    [requestId, ownerId],
  );
  if (!r) return { text: 'no such diagnostics request (it expires after two minutes)' };
  if (r.status === 'failed')
    return { text: `${r.name} refused or failed: ${maskSecrets(String(r.last_error ?? 'no reason given'))}` };
  if (r.status === 'done' && r.result) {
    await ctx.pool.query('UPDATE runner_commands SET result=NULL WHERE id=$1', [requestId]);
    const parsed = RunnerDiagnosticsResultSchema.safeParse(r.result);
    if (!parsed.success) return { text: `${r.name} sent an answer this server could not read` };
    // Masked on the runner, and again here: the text crosses a machine boundary.
    return {
      text: `# ${r.name}, runner ${parsed.data.runnerVersion}, ${parsed.data.kind}${parsed.data.truncated ? ' (cut: the end is shown)' : ''}\n${clip(maskSecrets(parsed.data.text))}`,
    };
  }
  if (r.status === 'done') return { text: 'that answer was already collected' };
  return { status: 'pending', requestId, message: `${r.name} has not answered yet` };
}
