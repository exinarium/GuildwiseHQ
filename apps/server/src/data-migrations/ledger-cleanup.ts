import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { orgScope, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * The owner-approved ledger clean-up of October 2026 (Lean Team v3, design section 10). It is a script, not a boot
 * migration: `pnpm --filter @aom/server tsx scripts/ledger-cleanup-2026-10.ts` prints what it would change (a dry run);
 * `--apply` writes it. It finds live standing orders by title/text match and appends `LedgerEntryRetired` events (the
 * history stays; a projection rebuild reproduces the result). Running it twice changes nothing the second time.
 */
export const LEDGER_CLEANUP_NAME = 'ledger-cleanup-2026-10';

interface Entry {
  id: string;
  org_id: string;
  project_id: string | null;
  title: string;
  body: string;
  created_at: Date;
}

/** One approved rule: which live standing orders it finds, and what happens to them. */
interface Rule {
  label: string;
  kind: 'merge' | 'retire';
  /** Expected number of matches on the owner's list (a different count is reported, not blocked). */
  expect?: number;
  reason: string;
  match: (e: Entry) => boolean;
}

const title = (re: RegExp) => (e: Entry) => re.test(e.title);
const titleOrBody = (re: RegExp) => (e: Entry) => re.test(e.title) || re.test(e.body);

export const CLEANUP_RULES: Rule[] = [
  // Retire the "ledger search" order first: the server attaches the best ledger matches to answer briefs instead (all copies).
  {
    label: '"ledger search" (x5)',
    kind: 'retire',
    expect: 5,
    reason: 'the server attaches the best ledger matches to answer briefs instead',
    match: title(/ledger\s+search/i),
  },
  // Duplicates: keep the newest, retire the rest.
  {
    label: '"Working Branch" (x2)',
    kind: 'merge',
    expect: 2,
    reason: 'duplicate',
    match: title(/^\s*working\s+branch\s*$/i),
  },
  {
    label: '"retry with back-off" (x2)',
    kind: 'merge',
    expect: 2,
    reason: 'duplicate',
    match: title(/retry\s+with\s+back-?\s?off/i),
  },
  // One-off orders HR promoted from card answers: they stay as decisions of their cards where they still apply.
  {
    label: '"pieter"',
    kind: 'retire',
    expect: 1,
    reason: 'a one-off answer promoted by HR; it stays a decision of its card',
    match: (e) =>
      /^\s*(add a standing order:\s*)?"?pieter"?\s*$/i.test(e.title) || /^\s*on\s+"pieter"\s*:/i.test(e.body),
  },
  {
    label: '"build P5-25 now"',
    kind: 'retire',
    expect: 1,
    reason: 'a one-off order promoted by HR; it stays a decision of its card',
    match: titleOrBody(/build\s+p5-25\s+now/i),
  },
  {
    label: '"bwrap" orders (x2)',
    kind: 'retire',
    expect: 2,
    reason: 'a one-off sandbox answer promoted by HR; it stays a decision of its card',
    match: titleOrBody(/\bbwrap\b/i),
  },
  // The contradiction between "Test Environment" (ask DevOps) and "Test mode" (do not wait) becomes a project setting.
  {
    label: '"Test Environment" and "Test mode"',
    kind: 'retire',
    expect: 2,
    reason: 'replaced by the project setting "test without an environment"',
    match: title(/^\s*test\s+(environment|mode)\s*$/i),
  },
];

export interface CleanupAction {
  entryId: string;
  orgId: string;
  projectId: string | null;
  title: string;
  rule: string;
  reason: string;
  /** For a merged duplicate: the entry that stays. */
  supersededBy?: string;
}

export interface CleanupPlan {
  actions: CleanupAction[];
  /** Per rule: how many live orders it found against how many the owner's list names. */
  found: Array<{ rule: string; count: number; expected: number | null; keeps: string | null }>;
}

/** Reads only: the live standing orders the rules find. */
export async function planLedgerCleanup(db: Queryable, opts: { orgId?: string } = {}): Promise<CleanupPlan> {
  const live = await rows<Entry>(
    db,
    `SELECT id, org_id, project_id, title, body, created_at FROM ledger_entries
      WHERE scope='standing_order' AND superseded_by IS NULL AND retired_at IS NULL AND ($1::uuid IS NULL OR org_id = $1)
      ORDER BY created_at DESC, id`,
    [opts.orgId ?? null],
  );
  const taken = new Set<string>();
  const plan: CleanupPlan = { actions: [], found: [] };
  for (const rule of CLEANUP_RULES) {
    const hits = live.filter((e) => !taken.has(e.id) && rule.match(e));
    let keep: Entry | undefined;
    if (rule.kind === 'merge') keep = hits[0]; // newest first
    for (const e of hits) {
      taken.add(e.id);
      if (e === keep) continue;
      plan.actions.push({
        entryId: e.id,
        orgId: e.org_id,
        projectId: e.project_id,
        title: e.title,
        rule: rule.label,
        reason: keep ? `duplicate of "${keep.title}" (${keep.id}), which stays` : rule.reason,
        ...(keep ? { supersededBy: keep.id } : {}),
      });
    }
    plan.found.push({
      rule: rule.label,
      count: hits.length,
      expected: rule.expect ?? null,
      keeps: keep ? keep.id : null,
    });
  }
  return plan;
}

/** The text the script prints: every change, one line each, and the rules that did not find what the list names. */
export function formatCleanupPlan(plan: CleanupPlan): string {
  const lines: string[] = [];
  for (const f of plan.found)
    lines.push(
      `${f.rule}: found ${f.count}${f.expected !== null ? ` (the list names ${f.expected})` : ''}${
        f.expected !== null && f.expected !== f.count ? '  <-- differs from the list, check below' : ''
      }`,
    );
  lines.push('');
  if (plan.actions.length === 0) lines.push('Nothing to change.');
  for (const a of plan.actions)
    lines.push(
      `RETIRE ${a.entryId} ${a.projectId ? `(project ${a.projectId})` : '(organization)'} "${a.title}"\n    rule: ${a.rule}; reason: ${a.reason}`,
    );
  lines.push('', `${plan.actions.length} order(s) would be retired.`);
  return lines.join('\n');
}

/** Writes the plan: one `LedgerEntryRetired` per action, by the system. Returns how many were retired. */
export async function applyLedgerCleanup(env: DataMigrationEnv, plan: CleanupPlan): Promise<number> {
  let n = 0;
  for (const a of plan.actions) {
    const did = await withAppendTx(env.pool, async (tx) => {
      const cur = (
        await rows<{ retired_at: Date | null; superseded_by: string | null }>(
          tx,
          'SELECT retired_at, superseded_by FROM ledger_entries WHERE id=$1 FOR UPDATE',
          [a.entryId],
        )
      )[0];
      if (!cur || cur.retired_at || cur.superseded_by) return false;
      await env.store.append(
        [
          {
            streamId: streamId.ledger(a.entryId),
            event: {
              type: 'LedgerEntryRetired',
              payload: {
                entryId: a.entryId,
                reason: `${LEDGER_CLEANUP_NAME}: ${a.reason}`.slice(0, 1000),
                ...(a.supersededBy ? { supersededBy: a.supersededBy } : {}),
                by: 'system',
              },
            },
            actor: SYSTEM_ACTOR,
            scope: a.projectId ? projectScope(a.orgId, a.projectId) : orgScope(a.orgId),
            correlationId: randomUUID(),
          },
        ],
        { tx },
      );
      return true;
    });
    if (did) {
      n++;
      env.log(`retired ${a.entryId} "${a.title}"`);
    }
  }
  return n;
}
