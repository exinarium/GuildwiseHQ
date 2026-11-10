/**
 * The multi-bug contract of a suite or regression failure report. The tester sends one `aom test fail` whose note has a
 * section per distinct bug: a line `Bug: <title>`, optionally a line `Test: <spec> > <name>`, then the details. The
 * server files one bug card per section and skips a bug that is already open (by its key).
 */

/** Bug cards one failing run files at most; further sections are appended to the last one. */
export const SUITE_BUGS_MAX = 20;

const KEY_MAX = 300;
const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
/**
 * The dedupe key of a bug title. The server computes the same key in SQL (projection and migration 2890):
 * `left('title:' || lower(btrim(regexp_replace(t, '\s+', ' ', 'g'))), 300)`.
 */
export const titleKey = (t: string): string => `title:${norm(t)}`.slice(0, KEY_MAX);
/** The dedupe key of a failing test id (`<spec file> > <test name>`). */
export const testKey = (t: string): string => `test:${norm(t)}`.slice(0, KEY_MAX);

export interface SuiteBug {
  title: string;
  test?: string;
  body: string;
  /** `testKey(test)` when the section names a test, else `titleKey(title)`. */
  failureKey: string;
  titleKey: string;
}

/** What the tester declared about the commit the target app runs (the first line of a suite failure note). */
export type TargetLine = { kind: 'match' | 'unknown' | 'mismatch'; deployed: string | null; line: string };

const TARGET_MISMATCH = /^\s*Target mismatch:\s*(.+)$/i;
const TARGET_UNKNOWN = /^\s*Target commit:\s*unknown\b.*$/i;
const TARGET_MATCH = /^\s*Target commit:\s*([0-9a-f]{7,40})\b.*$/i;
const SHA = /\b[0-9a-f]{7,40}\b/i;

const targetOf = (line: string): TargetLine | null => {
  const mismatch = TARGET_MISMATCH.exec(line);
  if (mismatch) return { kind: 'mismatch', deployed: SHA.exec(mismatch[1]!)?.[0] ?? null, line: line.trim() };
  if (TARGET_UNKNOWN.test(line)) return { kind: 'unknown', deployed: null, line: line.trim() };
  const match = TARGET_MATCH.exec(line);
  if (match) return { kind: 'match', deployed: match[1]!, line: line.trim() };
  return null;
};

/** The first `Target commit: <sha|unknown> ...` or `Target mismatch: ...` line of a suite failure note, or null. */
export function parseTargetLine(note: string): TargetLine | null {
  for (const line of note.split(/\r?\n/)) {
    const t = targetOf(line);
    if (t) return t;
  }
  return null;
}

const HEADER = /^\s*(?:#{1,4}\s*)?(?:\*\*)?Bug:(?:\*\*)?\s*(\S.*?)\s*$/i;
const TEST = /^\s*Test:\s*(\S.*)$/i;

/**
 * Splits a suite failure note into one bug per `Bug: <title>` section. A note without a section is one bug
 * (`fallbackTitle`, the whole note). Sections with the same key become one bug (bodies joined). Text before the first
 * section is the `preamble`. Sections past `SUITE_BUGS_MAX` are appended to the last bug and counted in `overflow`.
 */
export function parseSuiteBugs(
  note: string,
  fallbackTitle: string,
): { preamble: string; bugs: SuiteBug[]; overflow: number } {
  const lines = note.split(/\r?\n/);
  const pre: string[] = [];
  let targetDropped = false;
  const sections: Array<{ title: string; test?: string; body: string[] }> = [];
  for (const line of lines) {
    const h = HEADER.exec(line);
    if (h) {
      sections.push({ title: h[1]!.slice(0, KEY_MAX), body: [] });
      continue;
    }
    const cur = sections.at(-1);
    if (!cur) {
      // the target line (P3) is read by `parseTargetLine`, not repeated in every bug as run notes
      if (!targetDropped && targetOf(line)) targetDropped = true;
      else pre.push(line);
      continue;
    }
    if (cur.test === undefined && cur.body.every((l) => !l.trim())) {
      const t = TEST.exec(line);
      if (t) {
        cur.test = t[1]!.trim();
        continue;
      }
    }
    cur.body.push(line);
  }
  const preamble = pre.join('\n').trim();
  if (!sections.length) {
    const title = fallbackTitle.trim().slice(0, KEY_MAX);
    const tk = titleKey(title);
    return { preamble: '', bugs: [{ title, body: note.trim(), failureKey: tk, titleKey: tk }], overflow: 0 };
  }
  const bugs: SuiteBug[] = [];
  const byKey = new Map<string, SuiteBug>();
  let overflow = 0;
  for (const s of sections) {
    const body = s.body.join('\n').trim();
    const tk = titleKey(s.title);
    const failureKey = s.test ? testKey(s.test) : tk;
    const same = byKey.get(failureKey);
    if (same) {
      same.body = [same.body, body].filter(Boolean).join('\n\n');
      continue;
    }
    if (bugs.length >= SUITE_BUGS_MAX) {
      overflow++;
      const last = bugs.at(-1)!;
      const extra = [`Bug: ${s.title}`, s.test ? `Test: ${s.test}` : '', body].filter(Boolean).join('\n');
      last.body = [last.body, extra].filter(Boolean).join('\n\n');
      continue;
    }
    const bug: SuiteBug = {
      title: s.title,
      ...(s.test ? { test: s.test } : {}),
      body,
      failureKey,
      titleKey: tk,
    };
    bugs.push(bug);
    byKey.set(failureKey, bug);
  }
  return { preamble, bugs, overflow };
}
