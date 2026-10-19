import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeLabel } from './sanitize.ts';

/**
 * The work layer of the graph (docs/design/project-graphs.md section 5, step 5, and section 6): which cards landed in which
 * modules. A merge brings a card ref and title (the server owns those) and the paths git says changed; the runner maps the
 * paths to modules. Only refs and titles are kept, never a card body. Stored per repository in `repos/<repoKey>/_work.jsonl`
 * and listed for people in `work.md`; `touches` edges are derived on load.
 */
export interface WorkEntry {
  ref: string;
  title: string;
  /** The merge commit. */
  commit: string;
  /** ISO time of the merge. */
  at: string;
  /** Module directories (`apps/web`, `.` for the root) the merge touched. */
  mods: string[];
}

/** The newest entries kept per repository. */
export const WORK_MAX_ENTRIES = 200;

export const workFile = (graphDir: string, repoKey: string) =>
  join(graphDir, 'repos', repoKey, '_work.jsonl');

export function readWork(graphDir: string, repoKey: string): WorkEntry[] {
  const f = workFile(graphDir, repoKey);
  if (!existsSync(f)) return [];
  const out: WorkEntry[] = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as { t?: string } & Partial<WorkEntry>;
      if (o.t === 'w' && o.ref && o.commit && Array.isArray(o.mods))
        out.push({
          ref: String(o.ref),
          title: String(o.title ?? ''),
          commit: String(o.commit),
          at: String(o.at ?? ''),
          mods: o.mods.map(String),
        });
    } catch {
      // a damaged line is dropped
    }
  }
  return out;
}

/** Adds an entry (a merge seen twice is one entry) and keeps the newest `WORK_MAX_ENTRIES`. */
export function addWork(entries: WorkEntry[], add: WorkEntry): WorkEntry[] {
  const clean: WorkEntry = {
    ref: sanitizeLabel(add.ref, 40),
    title: sanitizeLabel(add.title, 200),
    commit: add.commit,
    at: add.at,
    mods: [...new Set(add.mods)].sort(),
  };
  const rest = entries.filter((e) => !(e.ref === clean.ref && e.commit === clean.commit));
  return [...rest, clean]
    .sort((a, b) =>
      a.at < b.at
        ? -1
        : a.at > b.at
          ? 1
          : a.ref < b.ref
            ? -1
            : a.ref > b.ref
              ? 1
              : a.commit < b.commit
                ? -1
                : 1,
    )
    .slice(-WORK_MAX_ENTRIES);
}

export function renderWork(entries: WorkEntry[]): string {
  return entries.length
    ? `${entries.map((e) => JSON.stringify({ t: 'w', ref: e.ref, title: e.title, commit: e.commit, at: e.at, mods: e.mods })).join('\n')}\n`
    : '';
}

/** `work.md`: for each module the cards that landed in it, newest first, without bodies. */
export function renderWorkMd(byRepo: Array<{ repoName: string; entries: WorkEntry[] }>): string {
  const out: string[] = [
    '# Work by module',
    '',
    'Which cards landed in which part of the code (card ref and title only). Derived from merges: rebuilt by the indexer, do not edit it.',
    '',
  ];
  let any = false;
  for (const r of byRepo) {
    const perModule = new Map<string, WorkEntry[]>();
    for (const e of r.entries)
      for (const m of e.mods) (perModule.get(m) ?? perModule.set(m, []).get(m))?.push(e);
    if (perModule.size === 0) continue;
    any = true;
    out.push(`## ${sanitizeLabel(r.repoName, 80)}`, '');
    for (const m of [...perModule.keys()].sort()) {
      out.push(`### \`${m === '.' ? '(root)' : m}\``);
      for (const e of [...(perModule.get(m) as WorkEntry[])].reverse().slice(0, 15))
        out.push(`- ${e.ref} ${e.title} (${e.commit.slice(0, 7)}, ${e.at.slice(0, 10)})`);
      out.push('');
    }
  }
  return any ? `${out.join('\n')}\n` : '';
}
