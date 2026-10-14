import {
  type CeoPolicy,
  CeoPolicySchema,
  type CeoSettings,
  CeoSettingsSchema,
  type CeoTraining,
  CeoTrainingSchema,
  DEFAULT_CEO_SETTINGS,
} from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';

export const ONLINE_WINDOW_MS = 45_000;
/** The runner announces `ceo:1` in its hello when it can run a CEO shift. */
export const CEO_CAPABILITY = 'ceo:1';

export interface CeoState {
  orgId: string;
  agentId: string | null;
  enabled: boolean;
  paused: boolean;
  pausedReason: string | null;
  settings: CeoSettings;
  policy: CeoPolicy;
  policyVersion: number;
  training: CeoTraining;
  chatThreadId: string | null;
  reportDay: string | null;
  enabledAt: Date;
}

export function parseSettings(raw: unknown): CeoSettings {
  const r = CeoSettingsSchema.safeParse(raw);
  return r.success ? r.data : DEFAULT_CEO_SETTINGS;
}

/** The CEO of an organization (also a disabled one), or undefined when it never had one. */
export async function loadCeo(db: Queryable, orgId: string): Promise<CeoState | undefined> {
  const r = await one(db, 'SELECT * FROM ceo_settings WHERE org_id=$1', [orgId]);
  if (!r) return undefined;
  return {
    orgId,
    agentId: r.agent_id ?? null,
    enabled: r.enabled,
    paused: r.paused,
    pausedReason: r.paused_reason ?? null,
    settings: parseSettings(r.settings),
    policy: CeoPolicySchema.parse(r.policy),
    policyVersion: r.policy_version,
    training: CeoTrainingSchema.parse(r.training),
    chatThreadId: r.chat_thread_id ?? null,
    reportDay: r.report_day ?? null,
    enabledAt: new Date(r.enabled_at),
  };
}

/** An enabled, unpaused CEO with an active agent: it owns the BA's reporter job. */
export async function ceoActive(db: Queryable, orgId: string): Promise<CeoState | undefined> {
  const c = await loadCeo(db, orgId);
  if (!c || !c.enabled || c.paused || !c.agentId) return undefined;
  const a = await one(db, `SELECT 1 FROM agents WHERE id=$1 AND status='active' AND paused_at IS NULL`, [c.agentId]);
  return a ? c : undefined;
}

export interface Reachable {
  ok: boolean;
  /** Why not (shown on the Overview and in the offline notice). */
  reason?: string;
  workstationId?: string;
  workstationName?: string;
}

/**
 * Can a CEO shift run right now? The CEO's workstation is connected, its runtime available (login not expired), its OS
 * sandbox not unavailable, and the runner announces `ceo:1`. Routing only holds items for a CEO that can look at them.
 */
export async function ceoReachable(db: Queryable, orgId: string, now: Date): Promise<Reachable> {
  const c = await loadCeo(db, orgId);
  if (!c || !c.enabled || !c.agentId) return { ok: false, reason: 'no CEO' };
  const a = await one(
    db,
    `SELECT a.runtime, a.status AS agent_status, ws.id AS ws_id, ws.name AS ws_name, ws.status AS ws_status, ws.connected,
            ws.last_seen_at, ws.runtimes,
            COALESCE((SELECT $4 = ANY(cap.capabilities) FROM workstation_capabilities cap WHERE cap.workstation_id = ws.id), false) AS capable,
            (${wsServesOrgSql('ws', 'a.org_id')}) AS serves
       FROM agents a LEFT JOIN workstations ws ON ws.id = a.workstation_id
      WHERE a.id=$1 AND a.org_id=$2 AND $3::timestamptz IS NOT NULL`,
    [c.agentId, orgId, now, CEO_CAPABILITY],
  );
  if (!a || a.agent_status !== 'active') return { ok: false, reason: 'the CEO agent is not active' };
  if (!a.ws_id || a.ws_status !== 'active') return { ok: false, reason: 'the CEO has no workstation' };
  const base = { workstationId: a.ws_id as string, workstationName: a.ws_name as string };
  if (!a.serves) return { ok: false, reason: 'this workstation does not serve the organization', ...base };
  const since = new Date(now.getTime() - ONLINE_WINDOW_MS);
  if (!a.connected || !a.last_seen_at || new Date(a.last_seen_at) < since)
    return { ok: false, reason: `${a.ws_name} is offline`, ...base };
  const rt = (a.runtimes as Array<{ id: string; available: boolean; sandbox?: string }> | null)?.find(
    (x) => x.id === a.runtime,
  );
  if (!rt?.available) return { ok: false, reason: `the ${a.runtime} runtime on ${a.ws_name} is not available (sign-in?)`, ...base };
  if (rt.sandbox === 'unavailable') return { ok: false, reason: `${a.ws_name} cannot sandbox agents`, ...base };
  if (!a.capable) return { ok: false, reason: `the runner on ${a.ws_name} is too old for the CEO: update it`, ...base };
  return { ok: true, ...base };
}
