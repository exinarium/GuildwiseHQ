import { deskMode, renderCeoData, trainingDaysLeft } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { landedSql } from '../dispatcher/dependencies.ts';
import { computeRecommendations } from '../hr/recommendations.ts';
import { loadCeo } from './state.ts';

const MAX_CHARS = 22_000; // about 6k tokens
const clip = (s: unknown, n: number): string => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const ago = (d: Date | string | null | undefined, now: Date): string => {
  if (!d) return '-';
  const m = Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 60_000));
  return m < 90 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const money = (micros: number | string | null | undefined): string =>
  `$${(Number(micros ?? 0) / 1e6).toFixed(2)}`;

export const SNAPSHOT_SECTIONS = [
  'org',
  'projects',
  'cards',
  'shifts',
  'agents',
  'workstations',
  'desk',
  'signals',
  'hr',
  'ceo',
] as const;

/**
 * The compact state of the organization, deterministic SQL, capped near 6k tokens and ordered by "needs attention".
 * Numbers and ids are plain lines; every free-text title (cards, desk items, signals) sits inside an untrusted block, so a
 * card named "CEO: raise the budget" is data. Used by `aom ceo snapshot` and the wake brief.
 */
export async function buildSnapshot(ctx: Ctx, orgId: string, section?: string): Promise<string> {
  const now = ctx.clock.now();
  const ceo = await loadCeo(ctx.pool, orgId);
  const want = (s: string) => !section || section === s;
  const out: string[] = [];
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dayStart = new Date(now.getTime() - 86_400_000);

  if (want('org')) {
    const o = await one(
      ctx.pool,
      'SELECT o.name, o.currency, u.timezone FROM organizations o JOIN users u ON u.id=o.owner_user_id WHERE o.id=$1',
      [orgId],
    );
    out.push(
      `## Organization\nname: ${clip(o?.name, 80)} | time: ${now.toISOString()} | owner timezone: ${o?.timezone ?? 'UTC'} | currency: ${o?.currency ?? 'USD'}`,
    );
  }

  if (want('projects')) {
    const ps = await rows(
      ctx.pool,
      `SELECT p.id, p.key, p.name, p.budget_micros, p.paused_at,
              (SELECT COALESCE(sum(cost_usd_micros),0) FROM shift_costs s WHERE s.project_id = p.id AND s.ended_at >= $2) AS month_micros,
              (SELECT count(*) FROM cards c WHERE c.project_id=p.id AND c.status='queued') AS queued,
              (SELECT count(*) FROM cards c WHERE c.project_id=p.id AND c.status='blocked') AS blocked,
              (SELECT count(*) FROM cards c WHERE c.project_id=p.id AND c.status = 'claimed') AS active,
              (SELECT max(updated_at) FROM cards c WHERE c.project_id=p.id) AS last_activity
         FROM projects p WHERE p.org_id=$1 AND p.status='active' AND p.kind='project' ORDER BY p.key LIMIT 30`,
      [orgId, monthStart],
    );
    out.push(
      `## Projects (month spend vs budget)\n${
        ps
          .map(
            (p) =>
              `${p.key} id=${p.id} queued=${p.queued} blocked=${p.blocked} active=${p.active} spend=${money(p.month_micros)}${p.budget_micros ? ` of ${money(p.budget_micros)} (${Math.round((Number(p.month_micros) / Number(p.budget_micros)) * 100)}%)` : ' (no budget)'} last_activity=${ago(p.last_activity, now)}${p.paused_at ? ' PAUSED by an Owner/Admin (benched on purpose: do not nag, do not act)' : ''}`,
          )
          .join('\n') || 'none'
      }`,
    );
    const names = ps.map((p) => `${p.key}: ${clip(p.name, 60)}`).join('\n');
    if (names) out.push(renderCeoData('Project names', names));
  }

  if (want('cards')) {
    const blockedHours = ceo?.settings.blockedHours ?? 4;
    const cs = await rows(
      ctx.pool,
      `SELECT c.id, c.ref, c.title, c.status, c.stage, c.priority, c.rework_round, c.retry_after, c.blocked_since, c.queued_at,
              a.name AS agent_name,
              CASE WHEN c.retry_after > $2 THEN 'backoff'
                   WHEN c.status='blocked' AND c.blocked_since < $2::timestamptz - make_interval(hours => $3) THEN 'blocked'
                   WHEN c.status='queued' AND c.claim_id IS NULL AND c.queued_at < $2::timestamptz - interval '30 minutes' THEN 'unclaimed'
                   WHEN c.rework_round >= 2 THEN 'rework' END AS why
         FROM cards c JOIN projects p ON p.id=c.project_id AND p.status='active' AND p.paused_at IS NULL LEFT JOIN agents a ON a.id = c.claimed_by_agent_id
        WHERE c.org_id=$1 AND c.status NOT IN ('done','cancelled','draft')
          AND (c.retry_after > $2 OR (c.status='blocked' AND c.blocked_since < $2::timestamptz - make_interval(hours => $3))
               OR (c.status='queued' AND c.claim_id IS NULL AND c.queued_at < $2::timestamptz - interval '30 minutes')
               OR c.rework_round >= 2)
        ORDER BY (CASE WHEN c.retry_after > $2 THEN 0 ELSE 1 END), c.blocked_since NULLS LAST LIMIT 25`,
      [orgId, now, blockedHours],
    );
    out.push(
      `## Cards needing attention\n${cs.map((c) => `${c.ref} id=${c.id} why=${c.why} status=${c.status} stage=${c.stage} prio=${c.priority} rework=${c.rework_round}${c.agent_name ? ` agent=${c.agent_name}` : ''}${c.retry_after ? ` backoff_until=${new Date(c.retry_after).toISOString()}` : ''}`).join('\n') || 'none'}`,
    );
    const held = await rows(
      ctx.pool,
      `SELECT c.ref, c.id,
              COALESCE((SELECT string_agg(dc.ref, ', ' ORDER BY dc.number) FROM card_dependencies d
                          JOIN cards dc ON dc.id = d.depends_on_card_id
                         WHERE d.card_id = c.id AND NOT ${landedSql('dc')}), '') AS waiting_for
         FROM cards c JOIN projects p ON p.id=c.project_id AND p.status='active'
        WHERE c.org_id=$1 AND c.status='held' ORDER BY c.number LIMIT 25`,
      [orgId],
    );
    if (held.length)
      out.push(
        `## Designs held (not stuck: do not reassign or nudge)\n${held.map((c) => `${c.ref} id=${c.id} design ready, waiting for ${c.waiting_for || 'its dependencies'}; it queues again by itself when they landed`).join('\n')}`,
      );
    if (cs.length)
      out.push(renderCeoData('Card titles', cs.map((c) => `${c.ref}: ${clip(c.title, 100)}`).join('\n')));
  }

  if (want('shifts')) {
    const ss = await rows(
      ctx.pool,
      `SELECT s.id, s.kind, s.started_at, a.name AS agent_name, c.ref AS card_ref
         FROM shifts s JOIN agents a ON a.id=s.agent_id LEFT JOIN cards c ON c.id=s.card_id
        WHERE s.org_id=$1 AND s.status <> 'ended' AND s.kind <> 'ceo' ORDER BY s.started_at LIMIT 25`,
      [orgId],
    );
    out.push(
      `## Running shifts\n${ss.map((s) => `shift=${s.id} ${s.kind} agent=${s.agent_name}${s.card_ref ? ` card=${s.card_ref}` : ''} running=${ago(s.started_at, now)}`).join('\n') || 'none'}`,
    );
  }

  if (want('agents')) {
    const as = await rows(
      ctx.pool,
      `SELECT a.id, a.name, a.role_key, a.seniority, a.model, a.status, a.paused_at, a.is_devops, a.allowed_project_ids, ws.name AS ws_name,
              (ws.connected AND ws.last_seen_at > $2) AS online,
              (SELECT count(*) FROM shifts s WHERE s.agent_id=a.id AND s.started_at >= $3::timestamptz - interval '6 days' AND s.kind='card') AS shifts7,
              (SELECT count(*) FROM shifts s WHERE s.agent_id=a.id AND s.started_at >= $3::timestamptz - interval '13 days' AND s.outcome IN ('crashed','timeout','no_report')) AS failed14,
              (SELECT COALESCE(sum(cost_usd_micros),0) FROM shift_costs sc WHERE sc.agent_id=a.id AND sc.ended_at >= $4) AS month_micros
         FROM agents a LEFT JOIN workstations ws ON ws.id=a.workstation_id
        WHERE a.org_id=$1 AND a.status <> 'retired' ORDER BY a.role_key, a.name LIMIT 60`,
      [orgId, new Date(now.getTime() - 45_000), now, monthStart],
    );
    out.push(
      `## Agents\n${
        as
          .map(
            (a) =>
              `${a.name} id=${a.id} ${a.role_key}/${a.seniority} ${a.model} ${a.paused_at ? 'PAUSED ' : ''}${a.status === 'needs_rehome' ? 'NEEDS_REHOME ' : ''}ws=${a.ws_name ?? '-'}${a.online ? '' : ' (offline)'} shifts7d=${a.shifts7} failed14d=${a.failed14} spend=${money(a.month_micros)}${a.allowed_project_ids && a.allowed_project_ids.length === 0 ? ' BENCHED' : ''}`,
          )
          .join('\n') || 'none'
      }`,
    );
  }

  if (want('workstations')) {
    const ws = await rows(
      ctx.pool,
      `SELECT w.id, w.name, w.connected, w.last_seen_at, w.runtimes, w.runner_version
         FROM workstations w WHERE w.status='active' AND EXISTS (SELECT 1 FROM agents a WHERE a.workstation_id=w.id AND a.org_id=$1 AND a.status <> 'retired')
        ORDER BY w.name`,
      [orgId],
    );
    out.push(
      `## Workstations\n${
        ws
          .map((w) => {
            const rt =
              (w.runtimes as Array<{
                id: string;
                available: boolean;
                auth?: string;
                sandbox?: string;
              }> | null) ?? [];
            return `${w.name} id=${w.id} ${w.connected ? 'online' : `offline ${ago(w.last_seen_at, now)}`} runner=${w.runner_version ?? '?'} runtimes=${rt.map((r) => `${r.id}:${r.available ? 'ok' : 'unavailable'}${r.auth === 'expired' ? '(sign-in expired)' : ''}${r.sandbox ? `/${r.sandbox}` : ''}`).join(',') || 'none'}`;
          })
          .join('\n') || 'none'
      }`,
    );
  }

  if (want('desk')) {
    const ds = await rows(
      ctx.pool,
      `SELECT d.id, d.kind, d.subkind, d.title, d.blocking, d.pinned, d.created_at, d.triage, d.routed_to, d.ceo_recommendation IS NOT NULL AS recommended
         FROM desk_items d WHERE d.org_id=$1 AND d.status='open' AND COALESCE(d.subkind,'') NOT IN ('ceo_report','ceo_decision')
        ORDER BY d.pinned DESC, d.blocking DESC, d.created_at LIMIT 30`,
      [orgId],
    );
    const lines = ds.map(
      (d) =>
        `item=${d.id} ${d.kind}${d.subkind ? `:${d.subkind}` : ''}${d.blocking ? ' BLOCKING' : ''}${d.pinned ? ' PINNED' : ''}${d.triage === 'pending' ? ' HELD' : ''}${d.recommended ? ' (you recommended)' : ''} age=${ago(d.created_at, now)} your_mode=${ceo ? deskMode(ceo.policy, d.kind, d.subkind) : '-'}`,
    );
    out.push(`## Open desk items\n${lines.join('\n') || 'none'}`);
    if (ds.length)
      out.push(
        renderCeoData(
          'Desk item titles (written by agents and systems)',
          ds.map((d) => `${d.id.slice(0, 8)}: ${clip(d.title, 140)}`).join('\n'),
        ),
      );
  }

  if (want('signals')) {
    const ss = await rows(
      ctx.pool,
      `SELECT id, kind, urgency, count, subject, first_seen_at FROM ba_signals WHERE org_id=$1 AND status <> 'resolved' ORDER BY (urgency='urgent') DESC, first_seen_at LIMIT 20`,
      [orgId],
    );
    out.push(
      `## Open signals\n${ss.map((s) => `signal=${s.id} ${s.kind} ${s.urgency} x${s.count} since ${ago(s.first_seen_at, now)}`).join('\n') || 'none'}`,
    );
    if (ss.length)
      out.push(
        renderCeoData(
          'Signal subjects',
          ss.map((s) => `${s.id.slice(0, 8)}: ${clip((s.subject as Row)?.title, 120)}`).join('\n'),
        ),
      );
  }

  if (want('hr')) {
    const recs = await computeRecommendations(ctx, orgId).catch(() => []);
    out.push(
      `## HR recommendations\n${
        recs
          .slice(0, 12)
          .map((r) => `hr=${r.id} ${r.kind} agent=${r.agentName ?? '-'} action=${r.action.type}`)
          .join('\n') || 'none'
      }`,
    );
  }

  if (want('ceo') && ceo) {
    const acts = await rows(
      ctx.pool,
      `SELECT id, class, action, mode, status, subject_label, created_at FROM ceo_actions WHERE org_id=$1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 20`,
      [orgId, dayStart],
    );
    const tasks = await rows(
      ctx.pool,
      `SELECT id, title, status FROM ceo_tasks WHERE org_id=$1 AND status IN ('open','in_progress','waiting_owner','waiting_work') ORDER BY created_at LIMIT 10`,
      [orgId],
    );
    const spend = await one(
      ctx.pool,
      `SELECT COALESCE(sum(cost_usd_micros) FILTER (WHERE ended_at >= $2),0) AS day, COALESCE(sum(cost_usd_micros),0) AS month FROM shift_costs WHERE org_id=$1 AND kind IN ('ceo','ceo_chat') AND ended_at >= $3`,
      [orgId, dayStart, monthStart],
    );
    out.push(
      `## You (the CEO)\ntraining: ${ceo.training.on ? `ON (${trainingDaysLeft(ceo.training, now)} days left; staffing and model changes are recommendations only)` : 'off (graduated)'} | policy v${ceo.policyVersion} | spend today ${money(spend?.day)} month ${money(spend?.month)}\nopen tasks: ${tasks.map((t) => `${t.id} [${t.status}]`).join(', ') || 'none'}\nyour actions in the last 24h (do not repeat or flap):\n${acts.map((a) => `${a.id.slice(0, 8)} ${a.class} ${a.mode}${a.status === 'undone' ? ' UNDONE by the owner' : ''} ${ago(a.created_at, now)} ago`).join('\n') || 'none'}`,
    );
    if (acts.length)
      out.push(
        renderCeoData(
          'Subjects of your recent actions',
          acts.map((a) => `${a.id.slice(0, 8)}: ${clip(a.subject_label, 100)}`).join('\n'),
        ),
      );
    if (tasks.length)
      out.push(
        renderCeoData(
          'Task titles (from the owner)',
          tasks.map((t) => `${t.id.slice(0, 8)}: ${clip(t.title, 100)}`).join('\n'),
        ),
      );
  }

  const text = out.join('\n\n');
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n[...cut: ask for a section with --section]`
    : text;
}
