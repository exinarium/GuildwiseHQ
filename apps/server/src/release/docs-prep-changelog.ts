import {
  type ChangelogEntriesTask,
  checkChangelog,
  RELEASE_DOCS_PREP_OUTPUT_MAX_BYTES,
  type ReleaseChangelogOutput,
  ReleaseChangelogOutputSchema,
  type ReleaseDocsPrepSummary,
  ReleasePrepChangelogPayloadSchema,
  unreleasedBullets,
  workReference,
} from '@aom/shared';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { loadFacts } from './facts.ts';

/**
 * The server half of the 'Write changelog' prep step: what to do when the run reaches the step for one repository,
 * and what of the runner's report is kept. The runner half merges the entries (apps/runner release-docs-prep-changelog).
 */

export const NEEDS_ANALYSE = 'Write changelog needs Analyse changes. Turn it on in the project settings.';
/** The source ids of a change summary: the commits and merges 'Analyse changes' found. */
export function summarySources(summary: ReleaseDocsPrepSummary): string[] {
  return [...new Set([...summary.commits.map((c) => c.sha), ...summary.merges.map((m) => m.sha)])];
}

/** Every source an earlier passed run already wrote, matched or skipped; plus the earlier prep commits themselves. */
export function coveredSourcesOf(outputs: readonly unknown[], prepCommits: readonly string[]): Set<string> {
  const out = new Set<string>(prepCommits);
  for (const o of outputs) {
    const p = ReleaseChangelogOutputSchema.safeParse(o);
    if (!p.success) continue;
    for (const e of p.data.added) for (const s of e.sources) out.add(s);
    for (const c of p.data.covered) out.add(c.source);
    for (const s of p.data.skipped) out.add(s.source);
  }
  return out;
}

export type ChangelogDispatch =
  | { kind: 'fail'; error: string }
  /** Nothing new to write: the runner gets no entries and leaves the file as it is. */
  | { kind: 'apply'; entries: [] }
  /** These changes need entries written. */
  | { kind: 'write'; uncovered: string[] };

/** Pure: the decision for one repository. `facts` is used only when it was read at the analysed head. */
export function decideChangelogDispatch(i: {
  summary: ReleaseDocsPrepSummary | null;
  facts: { headSha: string; changelog: string | null } | null;
  covered: ReadonlySet<string>;
}): ChangelogDispatch {
  if (!i.summary) return { kind: 'fail', error: NEEDS_ANALYSE };
  if (i.facts && i.facts.headSha === i.summary.headSha && i.facts.changelog !== null) {
    const { errors } = checkChangelog(i.facts.changelog);
    if (errors.length > 0) return { kind: 'fail', error: errors.join(' ') };
  }
  const uncovered = summarySources(i.summary).filter((s) => !i.covered.has(s));
  return uncovered.length === 0 ? { kind: 'apply', entries: [] } : { kind: 'write', uncovered };
}

/** The part of the runner's report that is stored: schema-checked, with the proposal's lists, at most 64 KB. */
export function storedChangelogOutput(
  output: unknown,
  payloadChangelog: unknown,
): ReleaseChangelogOutput | undefined {
  if (output === undefined) return undefined;
  const sent = ReleasePrepChangelogPayloadSchema.safeParse(payloadChangelog);
  const proposal = sent.success ? sent.data.proposal : undefined;
  const base = typeof output === 'object' && output !== null ? (output as Record<string, unknown>) : {};
  const parsed = ReleaseChangelogOutputSchema.safeParse({
    ...base,
    ...(proposal ? { covered: proposal.covered, skipped: proposal.skipped } : {}),
  });
  if (!parsed.success) return undefined;
  return JSON.stringify(parsed.data).length <= RELEASE_DOCS_PREP_OUTPUT_MAX_BYTES ? parsed.data : undefined;
}

/** Generic size cap for the other content steps' output. */
export function storedStepOutput(step: string, output: unknown, payloadChangelog: unknown): unknown {
  if (step === 'changelog') return storedChangelogOutput(output, payloadChangelog);
  if (output === undefined) return undefined;
  const json = JSON.stringify(output);
  return json !== undefined && json.length <= RELEASE_DOCS_PREP_OUTPUT_MAX_BYTES ? output : undefined;
}

/** Reads what the decision needs for one repository of a run. */
export async function changelogDispatchFor(
  db: Queryable,
  /** A release_docs_prep_runs row. */
  run: Row,
  /** A release_docs_prep_repos row. */
  repo: Row,
  summary: ReleaseDocsPrepSummary | null,
): Promise<ChangelogDispatch> {
  const covered = await coveredSourcesFor(db, run, repo);
  const f = await loadFacts(db, repo.repo_id);
  const facts = f?.facts ? { headSha: f.facts.headSha, changelog: f.facts.changelog ?? null } : null;
  return decideChangelogDispatch({ summary, facts, covered });
}

/** The sources earlier passed runs of the same release (branch, repository, base tag) already handled. */
export async function coveredSourcesFor(db: Queryable, run: Row, repo: Row): Promise<Set<string>> {
  const earlier = await rows(
    db,
    `SELECT s.output, r.commit_sha FROM release_docs_prep_runs u
       JOIN release_docs_prep_repos r ON r.run_id = u.id
       LEFT JOIN release_docs_prep_steps s ON s.run_id = u.id AND s.repo_id = r.repo_id AND s.step = 'changelog'
                                          AND s.phase IN ('', 'apply')
      WHERE u.project_id=$1 AND u.release_branch=$2 AND u.status='passed' AND u.id <> $3
        AND r.repo_id=$4 AND r.base_tag IS NOT DISTINCT FROM $5`,
    [run.project_id, run.release_branch, run.id, repo.repo_id, repo.base_tag],
  );
  return coveredSourcesOf(
    earlier.map((e) => e.output).filter((o) => o != null),
    earlier.map((e) => e.commit_sha).filter((c): c is string => typeof c === 'string'),
  );
}

const RUN_END: Record<string, string> = { passed: 'finished', failed: 'failed', skipped: 'was cancelled' };

/** Why a queued task of a release prep run must not start: the run ended (or is gone). Null while it is running. */
export async function prepRunEnded(db: Queryable, runId: string): Promise<string | null> {
  const run = await one(db, 'SELECT status FROM release_docs_prep_runs WHERE id=$1', [runId]);
  if (!run) return 'the release prep run ended (it no longer exists) before the task started';
  if (run.status === 'running') return null;
  return `the release prep run ended (it ${RUN_END[run.status as string] ?? run.status}) before the task started`;
}

/**
 * Names that must never reach a public entry. `terms` (members, workstations, host names) match as plain words;
 * `agentHandles` are agent names, which the entry check matches by their own rule when they are ordinary words.
 */
export async function changelogDenyList(
  db: Queryable,
  orgId: string,
): Promise<{ terms: string[]; agentHandles: string[] }> {
  const terms = new Set<string>();
  const agents = new Set<string>();
  const add = (into: Set<string>, v: unknown) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (t.length >= 3) into.add(t);
  };
  for (const a of await rows(db, 'SELECT name FROM agents WHERE org_id=$1', [orgId])) add(agents, a.name);
  for (const u of await rows(
    db,
    `SELECT u.display_name FROM users u JOIN org_members m ON m.user_id = u.id WHERE m.org_id=$1`,
    [orgId],
  ))
    add(terms, u.display_name);
  for (const w of await rows(
    db,
    `SELECT w.name, w.hostname FROM workstations w JOIN org_members m ON m.user_id = w.user_id WHERE m.org_id=$1`,
    [orgId],
  )) {
    add(terms, w.name);
    add(terms, w.hostname);
  }
  const lower = new Set([...terms].map((t) => t.toLowerCase()));
  // A handle that is also a member, workstation or host name stays a plain term: the strict match wins.
  return { terms: [...terms], agentHandles: [...agents].filter((h) => !lower.has(h.toLowerCase())) };
}

/** The changes no earlier run wrote, and the bullets already under Unreleased (from the facts at the analysed head). */
export async function changelogWriterInput(
  db: Queryable,
  run: Row,
  repo: Row,
  summary: ReleaseDocsPrepSummary,
) {
  const covered = await coveredSourcesFor(db, run, repo);
  const uncovered = summarySources(summary).filter((s) => !covered.has(s));
  const f = await loadFacts(db, repo.repo_id);
  const md = f?.facts?.changelog ?? null;
  const existing = md ? unreleasedBullets(md) : [];
  return { uncovered, existing };
}

/** The stored result of an accepted changelog proposal: the checked entries with the proposal's lists. */
export type StoredChangelogResult = {
  entries: { heading: string; text: string; sources: string[] }[];
  covered: ReleaseChangelogOutput['covered'];
  skipped: ReleaseChangelogOutput['skipped'];
};
export const storedChangelogResult = (
  entries: StoredChangelogResult['entries'],
  proposal: { covered: StoredChangelogResult['covered']; skipped: StoredChangelogResult['skipped'] },
): StoredChangelogResult => ({ entries, covered: proposal.covered, skipped: proposal.skipped });

interface ChangeCard {
  /** The card's work reference: its client ticket (`ABC-1`) for an intake card, otherwise its internal ref. */
  key: string;
  /** The internal ref (never shown to the writer for an intake card). */
  ref: string;
  title: string;
  client: boolean;
}

/**
 * The project's cards a release's merge keys name, by internal ref and, for an intake card, by its client ticket too
 * (merges name either). The work reference comes from workReference, so an intake card is always shown by its ticket.
 */
export async function resolveChangeCards(
  db: Queryable,
  projectId: string,
  keys: readonly string[],
): Promise<Map<string, ChangeCard>> {
  const out = new Map<string, ChangeCard>();
  if (!keys.length) return out;
  const found = await rows(
    db,
    `SELECT ref, title, fields FROM cards WHERE project_id=$1 AND status<>'cancelled'
        AND (ref = ANY($2) OR coalesce(fields->>'externalRef','') <> '') ORDER BY created_at, ref`,
    [projectId, [...keys]],
  );
  for (const c of found) {
    const wr = workReference({ ref: c.ref, fields: c.fields });
    const card: ChangeCard = { key: wr.ref, ref: c.ref, title: c.title, client: wr.isClientRef };
    out.set(c.ref, card);
    if (wr.isClientRef && !out.has(wr.ref)) out.set(wr.ref, card);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The subject with each intake card's internal ref replaced by its ticket, so the writer never sees the internal key. */
function subjectWithWorkRefs(subject: string, cards: readonly ChangeCard[]): string {
  let out = subject;
  for (const c of cards)
    if (c.client && c.key !== c.ref)
      out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(c.ref)}(?![0-9])`, 'g'), c.key);
  return out;
}

/** The changes the writer describes (and the accepted entries are mapped back to): merges with their cards, then commits. */
export async function changeListFor(
  db: Queryable,
  run: Row,
  summary: ReleaseDocsPrepSummary,
  uncovered: readonly string[],
): Promise<ChangelogEntriesTask['changes']> {
  const keys = [...new Set(summary.merges.flatMap((m) => m.cardKeys))];
  const cards = await resolveChangeCards(db, run.project_id, keys);
  // Jira keys are indexed upper case (workReference canonicalises them); a merge may name one in lower case.
  const lookup = (k: string) => cards.get(k) ?? cards.get(k.toUpperCase());
  const titles = new Map<string, string>();
  for (const c of summary.cards) if (c.title && !titles.has(c.key)) titles.set(c.key, c.title);
  const want = new Set(uncovered);
  const changes: ChangelogEntriesTask['changes'] = [];
  for (const m of summary.merges)
    if (want.has(m.sha)) {
      want.delete(m.sha);
      const matched: ChangeCard[] = [];
      const list: ChangelogEntriesTask['changes'][number]['cards'] = [];
      for (const k of m.cardKeys) {
        const c = lookup(k);
        const entry = c
          ? { key: c.key, title: c.title, ...(c.client ? { client: true } : {}) }
          : { key: k, title: titles.get(k) ?? null };
        if (c) matched.push(c);
        if (!list.some((x) => x.key === entry.key)) list.push(entry);
      }
      changes.push({
        source: m.sha,
        subject: subjectWithWorkRefs(m.subject, matched),
        cards: list,
        areas: [],
      });
    }
  for (const c of summary.commits)
    if (want.has(c.sha)) {
      want.delete(c.sha);
      changes.push({ source: c.sha, subject: c.subject, cards: [], areas: [] });
    }
  return changes;
}
