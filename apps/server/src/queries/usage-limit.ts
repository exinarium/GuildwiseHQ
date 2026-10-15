import type { ProjectDto } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { type Row, rows } from '../db/sql.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';

type UsageLimit = NonNullable<ProjectDto['usageLimit']>;

interface RuntimeRow {
  id?: string;
  usage?: string;
  limitedUntil?: string;
  limitedLabel?: string;
}

/** The workstation's Claude runtime is limited right now (`limitedUntil` still ahead), else null. */
export function activeUsageLimit(runtimes: unknown, runtime: string, now: Date): RuntimeRow | null {
  const rt = (Array.isArray(runtimes) ? (runtimes as RuntimeRow[]) : []).find((r) => r?.id === runtime);
  if (!rt || rt.usage !== 'limited' || !rt.limitedUntil) return null;
  return new Date(rt.limitedUntil).getTime() > now.getTime() ? rt : null;
}

/**
 * Backlog #73: which of these projects are paused by a model usage limit. A project is paused when every active agent of
 * its organization that runs on a Claude runtime sits on a workstation whose runtime is limited (the owner pauses the
 * project, not one machine): work on other workstations and runtimes keeps the project running. The earliest reset
 * is reported. Keyed by project id; projects that are not paused are absent.
 */
export async function usageLimitsFor(ctx: Ctx, projects: Row[]): Promise<Map<string, UsageLimit>> {
  const out = new Map<string, UsageLimit>();
  const now = ctx.clock.now();
  for (const orgId of new Set(projects.map((p) => p.org_id as string))) {
    const agents = await rows(
      ctx.pool,
      `SELECT a.runtime, ws.name AS ws_name, ws.runtimes
         FROM agents a JOIN workstations ws ON ws.id = a.workstation_id
        WHERE a.org_id = $1 AND a.status='active' AND a.role_key <> 'ceo' AND ws.status='active'
          AND ${wsServesOrgSql('ws', 'a.org_id')}`,
      [orgId],
    );
    if (agents.length === 0) continue;
    let earliest: { until: string; ws: string; label: string | null } | null = null;
    let allLimited = true;
    for (const a of agents) {
      const lim = a.runtime === 'claude-code' ? activeUsageLimit(a.runtimes, a.runtime, now) : null;
      if (!lim?.limitedUntil) {
        allLimited = false;
        break;
      }
      if (!earliest || lim.limitedUntil < earliest.until)
        earliest = { until: lim.limitedUntil, ws: a.ws_name, label: lim.limitedLabel ?? null };
    }
    if (!allLimited || !earliest) continue;
    for (const p of projects.filter((x) => x.org_id === orgId))
      out.set(p.id, { until: earliest.until, workstationName: earliest.ws, label: earliest.label });
  }
  return out;
}
