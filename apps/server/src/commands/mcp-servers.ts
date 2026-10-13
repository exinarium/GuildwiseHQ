import {
  MAX_MCP_SERVERS,
  type McpCall,
  type McpServerCandidateDto,
  McpServerInfoSchema,
  parseMcpToolName,
  streamId,
} from '@aom/shared';
import { z } from 'zod';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, forbidden } from '../errors.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';
import { projectScope, userActor } from './common.ts';

/**
 * Plugin MCP servers (docs/RUNNER.md "Plugin MCP servers"). The runner reports what the Claude Code plugins of a
 * workstation offer; the organization's Owner grants some of them to a project; the grant (names only) travels in
 * `shift.start` / `chat.start`. The configuration, and every secret in it, stays on the workstation.
 */

/** `mcp.servers` from the runner: replaces what the workstation reported before. Invalid entries are dropped. */
export async function applyMcpServersReport(ctx: Ctx, workstationId: string, report: unknown): Promise<void> {
  const parsed = z.object({ servers: z.array(z.unknown()).max(MAX_MCP_SERVERS) }).safeParse(report);
  if (!parsed.success) return;
  const servers = parsed.data.servers.flatMap((s) => {
    const p = McpServerInfoSchema.safeParse(s);
    return p.success ? [p.data] : [];
  });
  await exec(
    ctx.pool,
    `UPDATE workstations SET mcp_servers=$2::jsonb, mcp_servers_checked_at=$3 WHERE id=$1`,
    [workstationId, JSON.stringify(servers), ctx.clock.now()],
  );
}

/** What the user's own active workstations that may serve the organization report, one entry per server name. */
export async function mcpServerCandidates(
  db: Queryable,
  userId: string,
  orgId: string,
): Promise<McpServerCandidateDto[]> {
  const ws = await rows(
    db,
    `SELECT w.name, w.mcp_servers FROM workstations w
      WHERE w.user_id = $1 AND w.status = 'active' AND ${wsServesOrgSql('w', '$2::uuid')}
      ORDER BY w.name`,
    [userId, orgId],
  );
  const byName = new Map<string, McpServerCandidateDto>();
  for (const w of ws) {
    for (const raw of (w.mcp_servers ?? []) as unknown[]) {
      const s = McpServerInfoSchema.safeParse(raw);
      if (!s.success) continue;
      const have = byName.get(s.data.name);
      if (have) {
        if (!have.workstations.includes(w.name)) have.workstations.push(w.name);
        continue;
      }
      byName.set(s.data.name, {
        name: s.data.name,
        plugin: s.data.plugin,
        server: s.data.server,
        transport: s.data.transport,
        host: s.data.host ?? null,
        tools: s.data.tools ?? null,
        workstations: [w.name],
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The names granted to a project (what `shift.start` and `chat.start` carry). */
export async function grantedMcpServers(db: Queryable, projectId: string): Promise<string[]> {
  const p = await one<{ mcp_servers: string[] }>(db, 'SELECT mcp_servers FROM projects WHERE id=$1', [
    projectId,
  ]);
  return p?.mcp_servers ?? [];
}

/**
 * The organization's Owner (not an Admin, not the project owner as such) chooses which plugin MCP servers the project's
 * agents may use. The whole list is replaced. Each name must be one the Owner's own workstations report, or one the
 * project already has.
 */
export async function setProjectMcpServers(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  servers: string[],
): Promise<void> {
  const wanted = [...new Set(servers)].sort();
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if ((await orgRoleOf(tx, user.id, p.org_id)) !== 'owner')
      throw forbidden('only the organization Owner can grant MCP servers to a project');
    const current = [...((p.mcp_servers ?? []) as string[])].sort();
    if (JSON.stringify(current) === JSON.stringify(wanted)) return;
    const known = new Set((await mcpServerCandidates(tx, user.id, p.org_id)).map((c) => c.name));
    const bad = wanted.filter((n) => !known.has(n) && !current.includes(n));
    if (bad.length > 0)
      throw badRequest(
        'invalid_mcp_server',
        'an MCP server must be one of the plugin servers reported by one of your own workstations',
        { servers: bad },
      );
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectMcpServersSet', payload: { projectId, servers: wanted, by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

/**
 * Adds the MCP tool calls in a batch of progress items (`mcp__<server>__<tool>: <input>`) to the shift's tally, so the
 * card can show which servers and tools an agent used. Names only; the input summary stays in the progress tail.
 */
export function mcpCallsIn(items: Array<{ kind: string; text: string }>): McpCall[] {
  const tally = new Map<string, McpCall>();
  for (const i of items) {
    if (i.kind !== 'tool') continue;
    const name = i.text.split(':', 1)[0] ?? '';
    const m = parseMcpToolName(name.trim());
    if (!m) continue;
    const k = `${m.server}\u0000${m.tool}`;
    const have = tally.get(k);
    if (have) have.count += 1;
    else tally.set(k, { server: m.server, tool: m.tool, count: 1 });
  }
  return [...tally.values()];
}

export function mergeMcpCalls(a: McpCall[], b: McpCall[]): McpCall[] {
  const out = new Map<string, McpCall>();
  for (const c of [...a, ...b]) {
    const k = `${c.server}\u0000${c.tool}`;
    const have = out.get(k);
    if (have) have.count += c.count;
    else out.set(k, { ...c });
  }
  return [...out.values()].sort((x, y) => x.server.localeCompare(y.server) || x.tool.localeCompare(y.tool));
}
