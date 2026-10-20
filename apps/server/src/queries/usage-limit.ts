import {
  type AccountRuntimeView,
  accountUsable,
  MAIN_ACCOUNT,
  type ProjectDto,
  resolveShiftAccount,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { type Row, rows } from '../db/sql.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';

type UsageLimit = NonNullable<ProjectDto['usageLimit']>;

interface LimitFields {
  usage?: string;
  limitedUntil?: string;
  limitedLabel?: string;
}

interface RuntimeRow extends LimitFields {
  id?: string;
  accounts?: Array<LimitFields & { key: string }>;
}

/** The workstation's Claude runtime is limited right now (`limitedUntil` still ahead), else null. */
export function activeUsageLimit(runtimes: unknown, runtime: string, now: Date): RuntimeRow | null {
  const rt = (Array.isArray(runtimes) ? (runtimes as RuntimeRow[]) : []).find((r) => r?.id === runtime);
  if (!rt) return null;
  // The rule lives in the shared resolver (docs/design/claude-accounts.md): the runtime's top-level fields describe main.
  const view = {
    available: true,
    auth: 'ok' as const,
    usage: rt.usage as 'ok' | 'limited' | undefined,
    limitedUntil: rt.limitedUntil,
  };
  return accountUsable(view, MAIN_ACCOUNT, now) ? null : rt;
}

interface Blocker {
  until: string;
  ws: string;
  label: string | null;
  key: string;
}

/**
 * Backlog #73, project-aware since per-project Claude accounts (docs/design/claude-accounts.md 2.5). A project is
 * paused when no active agent that may work on it can run its tickets (`resolveShiftAccount` gives null for every
 * agent's workstation; the owner pauses the project, not one machine): its account is out and it does not fall back,
 * or main is out. It is on fallback when its account is out and its tickets run on main instead. Work on other
 * workstations and runtimes keeps the project running. The earliest reset is reported. Keyed by project id; projects
 * that run normally are absent. A pause with no reset time (a login that does not work) is not reported here: the
 * sign-in notice covers it.
 */
export async function usageLimitsFor(ctx: Ctx, projects: Row[]): Promise<Map<string, UsageLimit>> {
  const out = new Map<string, UsageLimit>();
  const now = ctx.clock.now();
  const limitOf = (e: LimitFields | undefined): (LimitFields & { limitedUntil: string }) | undefined =>
    e?.usage === 'limited' && e.limitedUntil && new Date(e.limitedUntil).getTime() > now.getTime()
      ? (e as LimitFields & { limitedUntil: string })
      : undefined;
  for (const orgId of new Set(projects.map((p) => p.org_id as string))) {
    const agents = await rows(
      ctx.pool,
      `SELECT a.runtime, a.allowed_project_ids, ws.name AS ws_name, ws.runtimes
         FROM agents a JOIN workstations ws ON ws.id = a.workstation_id
        WHERE a.org_id = $1 AND a.status='active' AND a.role_key <> 'ceo' AND NOT a.is_devops AND ws.status='active'
          AND ${wsServesOrgSql('ws', 'a.org_id')}`,
      [orgId],
    );
    for (const p of projects.filter((x) => x.org_id === orgId)) {
      const setting = p.claude_account_key
        ? { accountKey: p.claude_account_key as string, fallbackToMain: p.claude_account_fallback === true }
        : null;
      const own = setting?.accountKey ?? MAIN_ACCOUNT;
      const eligible = agents.filter((a) => !a.allowed_project_ids || a.allowed_project_ids.includes(p.id));
      if (eligible.length === 0) continue;
      const paused: Blocker[] = [];
      const fallback: Blocker[] = [];
      let running = false;
      let unreported = false;
      for (const a of eligible) {
        if (a.runtime !== 'claude-code') {
          running = true;
          break;
        }
        const rt = (Array.isArray(a.runtimes) ? (a.runtimes as RuntimeRow[]) : []).find(
          (r) => r?.id === 'claude-code',
        );
        const res = resolveShiftAccount(setting, rt as AccountRuntimeView | undefined, now);
        if (res && !res.viaFallback) {
          running = true;
          break;
        }
        const ownLimit = limitOf(
          rt?.accounts?.find((x) => x.key === own) ?? (own === MAIN_ACCOUNT ? rt : undefined),
        );
        const mainLimit = limitOf(rt?.accounts?.find((x) => x.key === MAIN_ACCOUNT) ?? rt);
        if (res) {
          // Running on main because the project's account is out.
          if (ownLimit)
            fallback.push({
              until: ownLimit.limitedUntil,
              ws: a.ws_name,
              label: ownLimit.limitedLabel ?? null,
              key: own,
            });
          continue;
        }
        const blocking = ownLimit ?? mainLimit;
        if (!blocking) {
          unreported = true;
          continue;
        }
        paused.push({
          until: blocking.limitedUntil,
          ws: a.ws_name,
          label: blocking.limitedLabel ?? null,
          key: ownLimit ? own : MAIN_ACCOUNT,
        });
      }
      if (running) continue;
      const mode = fallback.length > 0 ? 'fallback' : 'paused';
      const list = mode === 'fallback' ? fallback : paused;
      // Paused: every agent must be out for the project to count as paused (one on a login problem may come back any time).
      if (list.length === 0 || (mode === 'paused' && unreported)) continue;
      const first = list.reduce((x, y) => (y.until < x.until ? y : x));
      out.set(p.id, {
        until: first.until,
        workstationName: first.ws,
        label: first.label,
        accountKey: first.key,
        mode,
      });
    }
  }
  return out;
}
