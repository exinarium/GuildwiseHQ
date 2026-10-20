import {
  evaluateGate,
  type Gate,
  type GateEvidence,
  type GateFacts,
  GateSchema,
  type GateVerdict,
  type RecipeEnv,
  resolveGate,
} from '@aom/shared';
import { orgOwnerId } from '../auth/org-context.ts';
import { one, type Queryable, rows } from '../db/sql.ts';

/**
 * The gate of an environment, deterministic and over facts the server already holds (docs/design/ceo-front-door.md 9.3):
 * deploy runs and their health, the regression and E2E test runs, phases, merges and the clock. No model is involved.
 */

export async function loadPresets(db: Queryable, orgId: string): Promise<Record<string, Gate>> {
  const out: Record<string, Gate> = {};
  for (const r of await rows(db, 'SELECT name, gate FROM gate_presets WHERE org_id=$1', [orgId])) {
    const g = GateSchema.safeParse(r.gate);
    if (g.success) out[r.name] = g.data;
  }
  return out;
}

/**
 * The gates that apply to an environment: the recipe's own plus the organization's bindings ("the standard rule for this
 * project or repository"). A binding adds to the recipe, never replaces it: the Owner's rule cannot be loosened by a recipe.
 * A preset that no longer exists makes the environment unreleasable (`missingPreset`).
 */
export async function effectiveGates(
  db: Queryable,
  p: {
    orgId: string;
    projectId: string;
    env: Pick<RecipeEnv, 'gate'>;
    production: boolean;
    repoId?: string | null;
  },
): Promise<{ gates: Array<{ label: string; gate: Gate }>; missingPreset?: string }> {
  const presets = await loadPresets(db, p.orgId);
  const own = resolveGate(p.env, presets);
  if (!own) return { gates: [], missingPreset: String(p.env.gate) };
  const gates: Array<{ label: string; gate: Gate }> = [{ label: 'recipe', gate: own }];
  const bindings = await rows(
    db,
    `SELECT preset, env_match FROM gate_bindings
      WHERE org_id=$1 AND (project_id = $2 OR (project_id IS NULL AND repo_id IS NOT NULL AND repo_id = $3))
        AND (env_match = '*' OR (env_match = 'production' AND $4::boolean))`,
    [p.orgId, p.projectId, p.repoId ?? null, p.production],
  );
  for (const b of bindings) {
    const g = presets[b.preset];
    if (!g) return { gates, missingPreset: b.preset };
    gates.push({ label: `rule ${b.preset}`, gate: g });
  }
  return { gates };
}

/** The newest merge into the project (when it landed), from the events. */
export async function latestMerge(
  db: Queryable,
  projectId: string,
): Promise<{ commit: string; at: Date } | null> {
  const r = await one(
    db,
    `SELECT payload->'resultRef'->>'mergeCommit' AS commit, created_at FROM events
      WHERE project_id=$1 AND type='CardFinalized' AND payload->'resultRef'->>'mergeCommit' IS NOT NULL
      ORDER BY seq DESC LIMIT 1`,
    [projectId],
  );
  return r ? { commit: r.commit, at: r.created_at } : null;
}

export async function collectGateFacts(
  db: Queryable,
  p: { orgId: string; projectId: string; commit: string | null; now: Date },
): Promise<GateFacts> {
  const envRuns: GateFacts['envRuns'] = {};
  for (const r of await rows(
    db,
    `SELECT id, env, COALESCE(deployed_commit, commit) AS commit, finished_at FROM deploy_runs
      WHERE project_id=$1 AND status='succeeded' AND NOT trial AND NOT dry_run
        AND (health IS NULL OR COALESCE((health->>'ok')::boolean, true))
      ORDER BY finished_at DESC LIMIT 300`,
    [p.projectId],
  )) {
    const list = envRuns[r.env] ?? [];
    list.push({ id: r.id, commit: r.commit ?? null, healthyAt: r.finished_at });
    envRuns[r.env] = list;
  }
  const merge = await latestMerge(db, p.projectId);
  const checks: GateFacts['checks'] = {};
  for (const [kind, testKind] of [
    ['regression', 'regression'],
    ['e2e', 'full_suite'],
  ] as const) {
    const t = await one(
      db,
      `SELECT t.id, t.result, t.created_at, t.evidence->>'commit' AS commit FROM test_runs t JOIN cards c ON c.id = t.card_id
        WHERE c.project_id=$1 AND t.kind=$2 ORDER BY t.created_at DESC, t.id DESC LIMIT 1`,
      [p.projectId, testKind],
    );
    if (!t || t.result !== 'passed') continue;
    // A test run that names no commit counts only when it finished after the newest merge (it tested what is there now).
    if (!t.commit && merge && t.created_at < merge.at) continue;
    checks[kind] = { id: t.id, passedAt: t.created_at, commit: t.commit ?? null };
  }
  // "The commit is the merge of a done phase": the latest completed phase counts with ITS merge commit (the last merge of
  // one of its cards, else the newest merge before it completed); the commit that was asked for never stands in for it.
  const phaseDoneCommits: GateFacts['phaseDoneCommits'] = [];
  const ph = await one(
    db,
    `SELECT ph.id, ph.completed_at FROM phases ph
      WHERE ph.project_id=$1 AND ph.completed_at IS NOT NULL AND ph.status NOT IN ('discarded','cancelled')
      ORDER BY ph.completed_at DESC LIMIT 1`,
    [p.projectId],
  );
  if (ph) {
    const m = await one(
      db,
      `SELECT payload->'resultRef'->>'mergeCommit' AS commit FROM events
        WHERE project_id=$1 AND type='CardFinalized' AND payload->'resultRef'->>'mergeCommit' IS NOT NULL
          AND (payload->>'cardId' IN (SELECT id::text FROM cards WHERE phase_id=$2) OR created_at <= $3)
        ORDER BY (payload->>'cardId' IN (SELECT id::text FROM cards WHERE phase_id=$2)) DESC, seq DESC LIMIT 1`,
      [p.projectId, ph.id, ph.completed_at],
    );
    if (m?.commit) phaseDoneCommits.push({ id: ph.id, commit: m.commit });
  }
  const tz = await one(db, 'SELECT timezone FROM users WHERE id=$1', [await orgOwnerId(db, p.orgId)]);
  return {
    now: p.now,
    timezone: tz?.timezone ?? null,
    commit: p.commit,
    envRuns,
    checks,
    phaseDoneCommits,
    latestMergeCommit: merge?.commit ?? null,
  };
}

export interface EnvGateVerdict extends GateVerdict {
  /** The gates that were evaluated (the recipe's and the bindings'), for the audit event. */
  gates: Array<{ label: string; gate: Gate }>;
}

/** All applicable gates must hold; the evidence of each is kept. */
export async function evaluateEnvGate(
  db: Queryable,
  p: {
    orgId: string;
    projectId: string;
    env: Pick<RecipeEnv, 'gate'>;
    production: boolean;
    commit: string | null;
    now: Date;
    repoId?: string | null;
  },
): Promise<EnvGateVerdict> {
  const { gates, missingPreset } = await effectiveGates(db, p);
  if (missingPreset)
    return {
      satisfied: false,
      missing: [`the gate preset ${missingPreset} does not exist`],
      evidence: [],
      gates,
    };
  const facts = await collectGateFacts(db, p);
  const missing: string[] = [];
  const evidence: GateEvidence[] = [];
  for (const g of gates) {
    const v = evaluateGate(g.gate, facts);
    missing.push(...v.missing);
    evidence.push(...v.evidence);
  }
  return { satisfied: missing.length === 0, missing: [...new Set(missing)], evidence, gates };
}
