import { type ComponentBump, composeReleaseSection, releaseIntro } from './components.ts';

/** The `## [Unreleased]` block of a Keep a Changelog file: its text split into the intro and the entries. */
export interface UnreleasedSplit {
  intro: string;
  body: string;
  /** Line index of the `## [Unreleased]` heading. */
  start: number;
  /** Line index after the last line of the block (the next version heading, a link reference or the end). */
  end: number;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VERSION_HEADING = /^##\s+\[[^\]]+\]/;
const LINK_REF = /^\[[^\]]+\]:\s/;

function linesOf(md: string): { lines: string[]; eol: string; trailing: boolean } {
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  const trailing = /\r?\n$/.test(md);
  const lines = md.split(/\r?\n/);
  if (trailing) lines.pop();
  return { lines, eol, trailing };
}

/**
 * Locates the Unreleased block. `intro` and `body` are what the server's `parseUnreleased` yields (the intro is the
 * non-blank lines before the first `###`, joined with single spaces; the body runs from the first `###` to the end of
 * the block, trimmed), so the preview and the commit agree.
 */
export function splitUnreleased(md: string): UnreleasedSplit | null {
  const { lines } = linesOf(md);
  const start = lines.findIndex((l) => /^##\s+\[unreleased\]/i.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] as string;
    if (VERSION_HEADING.test(l) || LINK_REF.test(l)) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start + 1, end);
  const first = block.findIndex((l) => /^###\s/.test(l));
  const introLines = (first < 0 ? block : block.slice(0, first))
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^#{1,2}\s/.test(l));
  const intro = introLines.join(' ').replace(/\s+/g, ' ').trim();
  const body = (first < 0 ? '' : block.slice(first).join('\n')).trim();
  return { intro, body, start, end };
}

/** Whether `## [version]` already is a heading of the file. */
export function hasReleaseSection(md: string, version: string): boolean {
  return new RegExp(`^##\\s+\\[${escapeRe(version)}\\]`, 'm').test(md);
}

/** The text of an existing `## [version]` block (heading included), trimmed; null when absent. */
export function releaseSectionOf(md: string, version: string): string | null {
  const { lines } = linesOf(md);
  const re = new RegExp(`^##\\s+\\[${escapeRe(version)}\\]`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] as string;
    if (VERSION_HEADING.test(l) || LINK_REF.test(l)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

export type ReleaseChangelogOutcome =
  | { kind: 'rewritten'; md: string; section: string }
  | { kind: 'already'; section: string }
  | { kind: 'error'; message: string };

export interface ReleaseChangelogInput {
  version: string;
  date: string;
  bumps: readonly ComponentBump[];
}

/**
 * Moves the Unreleased entries under `## [version] - date`, leaves an empty `## [Unreleased]` above it and extends the
 * intro line with one sentence per component. Every line outside the Unreleased block stays as it was.
 */
export function releaseChangelog(md: string, input: ReleaseChangelogInput): ReleaseChangelogOutcome {
  const existing = releaseSectionOf(md, input.version);
  if (existing !== null) return { kind: 'already', section: existing };
  const split = splitUnreleased(md);
  if (!split) return { kind: 'error', message: 'CHANGELOG.md has no ## [Unreleased] section' };
  const { lines, eol, trailing } = linesOf(md);
  const section = composeReleaseSection(
    input.version,
    input.date,
    releaseIntro(split.intro, input.bumps),
    split.body,
  );
  const tail = lines.slice(split.end);
  const out = [
    ...lines.slice(0, split.start),
    '## [Unreleased]',
    '',
    ...section.split('\n'),
    ...(tail.length > 0 ? [''] : []),
    ...tail,
  ];
  return { kind: 'rewritten', md: out.join(eol) + (trailing ? eol : ''), section };
}

/** A new CHANGELOG.md (the repository has none): the approved notes become the first release. */
export function newChangelog(
  projectName: string,
  input: ReleaseChangelogInput & { notes: string },
): { md: string; section: string } {
  const notes = input.notes.trim();
  const body = notes === '' || /^###\s/.test(notes) ? notes : `### Changed\n\n${notes}`;
  const section = composeReleaseSection(input.version, input.date, releaseIntro('', input.bumps), body);
  const md = [
    '# Changelog',
    '',
    `All notable changes to ${projectName.trim() || 'this project'} are documented in this file.`,
    '',
    '## [Unreleased]',
    '',
    section,
    '',
  ].join('\n');
  return { md, section };
}

// ---------------------------------------------------------------------------------------------------------------------
// Release prep: writing entries into the Unreleased block (the 'Write changelog' step). The functions above are the
// release commit's; these only ever edit the lines between `## [Unreleased]` and the next version heading.

export type ChangelogHeading = 'Added' | 'Changed' | 'Deprecated' | 'Removed' | 'Fixed' | 'Security';
/** The Keep a Changelog headings the release notes parser maps, in file order. */
export const CHANGELOG_HEADINGS: readonly ChangelogHeading[] = [
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
];

export interface ChangelogEntry {
  heading: ChangelogHeading;
  text: string;
}

/** The heading as written in `CHANGELOG_HEADINGS` (any case), or null. */
export const changelogHeadingOf = (name: string): ChangelogHeading | null =>
  CHANGELOG_HEADINGS.find((h) => h.toLowerCase() === name.trim().toLowerCase()) ?? null;

const UNRELEASED_HEADING = /^##\s+\[unreleased\]/i;
const DATED_VERSION_HEADING = /^##\s+\[[^\]]+\]\s*-\s*\d{4}-\d{2}-\d{2}/;
const SUB_HEADING = /^###\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;

/**
 * Structural problems that make the file unsafe to edit or unusable by the release commit. `errors` fail the step;
 * `warnings` are shown only. Each message is a full sentence naming the line.
 */
export function checkChangelog(
  md: string,
  opts: { version?: string } = {},
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (md.includes('\u0000') || md.includes('�')) {
    errors.push('CHANGELOG.md is not a readable text file (it contains binary or corrupted characters).');
    return { errors, warnings };
  }
  const { lines } = linesOf(md);
  const unreleased = lines.flatMap((l, i) => (UNRELEASED_HEADING.test(l) ? [i] : []));
  if (unreleased.length === 0) {
    errors.push('CHANGELOG.md has no ## [Unreleased] section.');
    return { errors, warnings };
  }
  if (unreleased.length > 1)
    errors.push(
      `CHANGELOG.md has more than one ## [Unreleased] section (lines ${unreleased.map((i) => i + 1).join(', ')}). Keep one and retry prep.`,
    );
  const start = unreleased[0] as number;
  const firstVersion = lines.findIndex((l) => VERSION_HEADING.test(l) && !UNRELEASED_HEADING.test(l));
  if (firstVersion >= 0 && firstVersion < start)
    errors.push(
      `CHANGELOG.md has ## [Unreleased] on line ${start + 1}, below the version heading on line ${firstVersion + 1}. Move ## [Unreleased] above every version and retry prep.`,
    );
  const newestDated = lines.findIndex((l) => DATED_VERSION_HEADING.test(l));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (!VERSION_HEADING.test(l) || UNRELEASED_HEADING.test(l) || DATED_VERSION_HEADING.test(l)) continue;
    const version = /^##\s+\[([^\]]+)\]/.exec(l)?.[1] ?? '';
    if (newestDated >= 0 && i < newestDated)
      errors.push(
        `CHANGELOG.md already has a ## [${version}] section without a date (line ${i + 1}). Ship would treat ${version} as released and ignore Unreleased. Move its entries under ## [Unreleased] and remove the heading, then retry prep.`,
      );
  }
  if (opts.version) {
    const re = new RegExp(`^##\\s+\\[${escapeRe(opts.version)}\\]`);
    const at = lines.findIndex((l) => re.test(l));
    if (at >= 0 && !DATED_VERSION_HEADING.test(lines[at] as string) && newestDated < 0)
      errors.push(
        `CHANGELOG.md already has a ## [${opts.version}] section without a date (line ${at + 1}). Ship would treat ${opts.version} as released and ignore Unreleased. Move its entries under ## [Unreleased] and remove the heading, then retry prep.`,
      );
    if (at >= 0 && DATED_VERSION_HEADING.test(lines[at] as string))
      errors.push(
        `CHANGELOG.md already has a released ## [${opts.version}] section (line ${at + 1}). Entries written now would not be part of ${opts.version}.`,
      );
  }
  const split = splitUnreleased(md);
  if (split) {
    let inSection = false;
    for (let i = split.start + 1; i < split.end; i++) {
      const l = lines[i] as string;
      const h = SUB_HEADING.exec(l);
      if (h) {
        inSection = true;
        const name = (h[1] ?? '').trim();
        if (!changelogHeadingOf(name))
          warnings.push(
            `CHANGELOG.md has an Unreleased heading '### ${name}' (line ${i + 1}) that the release notes do not show; its entries stay as written.`,
          );
        continue;
      }
      if (BULLET.test(l) && !inSection)
        errors.push(
          `CHANGELOG.md has an Unreleased entry on line ${i + 1} that is not under a ### heading, so the release notes would drop it. Put it under ### Added, ### Changed or ### Fixed and retry prep.`,
        );
    }
  }
  return { errors, warnings };
}

/** The header `newChangelog` writes, ending with an empty Unreleased block. */
export function changelogSkeleton(projectName: string): string {
  return [
    '# Changelog',
    '',
    `All notable changes to ${projectName.trim() || 'this project'} are documented in this file.`,
    '',
    '## [Unreleased]',
    '',
  ].join('\n');
}

/** The bullets of the Unreleased block (continuation lines joined) with their heading. */
export function unreleasedBullets(md: string): { heading: string; text: string }[] {
  const split = splitUnreleased(md);
  if (!split) return [];
  const { lines } = linesOf(md);
  const out: { heading: string; text: string }[] = [];
  let heading = '';
  let cur: { heading: string; parts: string[] } | null = null;
  const flush = () => {
    if (cur) out.push({ heading: cur.heading, text: cur.parts.join(' ').replace(/\s+/g, ' ').trim() });
    cur = null;
  };
  for (let i = split.start + 1; i < split.end; i++) {
    const l = lines[i] as string;
    const h = SUB_HEADING.exec(l);
    if (h) {
      flush();
      heading = (h[1] ?? '').trim();
      continue;
    }
    const b = BULLET.exec(l);
    if (b) {
      flush();
      cur = { heading, parts: [b[1] ?? ''] };
    } else if (l.trim() === '') flush();
    else if (cur && /^\s/.test(l)) (cur as { parts: string[] }).parts.push(l.trim());
    else flush();
  }
  flush();
  return out;
}

/** Normalised text used for duplicate checks. */
export function entryKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const wordsOf = (text: string): Set<string> =>
  new Set(
    entryKey(text)
      .split(' ')
      .filter((w) => /^[a-z]{3,}$/.test(w)),
  );

/** Same text once normalised, or near-identical wording (Jaccard >= 0.8 over words of 3+ letters, 6+ words each). */
export function isDuplicateEntry(a: string, b: string): boolean {
  const ka = entryKey(a);
  if (ka !== '' && ka === entryKey(b)) return true;
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  if (wa.size < 6 || wb.size < 6) return false;
  let both = 0;
  for (const w of wa) if (wb.has(w)) both++;
  return both / (wa.size + wb.size - both) >= 0.8;
}

export type MergeUnreleasedOutcome =
  | { kind: 'merged'; md: string; added: ChangelogEntry[]; duplicates: ChangelogEntry[] }
  | { kind: 'unchanged'; duplicates: ChangelogEntry[] }
  | { kind: 'error'; message: string };

interface BlockSection {
  headingLine: string;
  name: string;
  lines: string[];
}

const trimBlank = (ls: string[]): string[] => {
  const out = [...ls];
  while (out.length > 0 && (out[0] as string).trim() === '') out.shift();
  while (out.length > 0 && (out[out.length - 1] as string).trim() === '') out.pop();
  return out;
};

/** True when two bullets of the section are separated by a blank line. */
const isLoose = (ls: string[]): boolean | null => {
  const bullets = ls.flatMap((l, i) => (BULLET.test(l) ? [i] : []));
  if (bullets.length < 2) return null;
  for (let k = 1; k < bullets.length; k++) {
    const between = ls.slice((bullets[k - 1] as number) + 1, bullets[k]);
    if (between.some((l) => l.trim() === '')) return true;
  }
  return false;
};

/**
 * Adds the entries that are not already in the Unreleased block, each after the last bullet of its heading (a missing
 * heading is created in Keep a Changelog order). Every byte outside the block is kept; `unchanged` means the caller
 * must not write the file.
 */
export function mergeUnreleased(md: string, entries: readonly ChangelogEntry[]): MergeUnreleasedOutcome {
  const check = checkChangelog(md);
  if (check.errors.length > 0) return { kind: 'error', message: check.errors[0] as string };
  const split = splitUnreleased(md);
  if (!split) return { kind: 'error', message: 'CHANGELOG.md has no ## [Unreleased] section.' };
  const { lines, eol, trailing } = linesOf(md);

  const existing = unreleasedBullets(md).map((b) => b.text);
  const added: ChangelogEntry[] = [];
  const duplicates: ChangelogEntry[] = [];
  for (const raw of entries) {
    const heading = changelogHeadingOf(raw.heading);
    const text = raw.text.replace(/\s+/g, ' ').trim();
    if (!heading || text === '')
      return { kind: 'error', message: `internal: invalid entry '${raw.heading}'` };
    const e = { heading, text };
    if ([...existing, ...added.map((a) => a.text)].some((t) => isDuplicateEntry(t, text))) duplicates.push(e);
    else added.push(e);
  }
  if (added.length === 0) return { kind: 'unchanged', duplicates };

  const block = lines.slice(split.start + 1, split.end);
  const first = block.findIndex((l) => SUB_HEADING.test(l));
  const preamble = trimBlank(first < 0 ? block : block.slice(0, first));
  const sections: BlockSection[] = [];
  if (first >= 0)
    for (const l of block.slice(first)) {
      const h = SUB_HEADING.exec(l);
      if (h) sections.push({ headingLine: l, name: (h[1] ?? '').trim(), lines: [] });
      else (sections[sections.length - 1] as BlockSection).lines.push(l);
    }
  for (const s of sections) s.lines = trimBlank(s.lines);

  let loose: boolean | null = null;
  for (const s of sections) loose ??= isLoose(s.lines);
  if (loose === null) {
    // The first ### section of the whole file with two or more bullets decides; a file without any is loose.
    let cur: string[] | null = null;
    const all: string[][] = [];
    for (const l of lines) {
      if (VERSION_HEADING.test(l) || SUB_HEADING.test(l)) {
        if (cur) all.push(cur);
        cur = SUB_HEADING.test(l) ? [] : null;
      } else if (cur) cur.push(l);
    }
    if (cur) all.push(cur);
    for (const s of all) loose ??= isLoose(trimBlank(s));
  }
  const sep = loose === false ? [] : [''];

  for (const e of added) {
    let s = sections.find((x) => changelogHeadingOf(x.name) === e.heading);
    if (!s) {
      s = { headingLine: `### ${e.heading}`, name: e.heading, lines: [] };
      const rank = CHANGELOG_HEADINGS.indexOf(e.heading);
      const before = sections.findIndex((x) => {
        const h = changelogHeadingOf(x.name);
        return h !== null && CHANGELOG_HEADINGS.indexOf(h) > rank;
      });
      if (before < 0) sections.push(s);
      else sections.splice(before, 0, s);
    }
    s.lines = s.lines.length === 0 ? [`- ${e.text}`] : [...s.lines, ...sep, `- ${e.text}`];
  }

  const tail = lines.slice(split.end);
  const out: string[] = [...lines.slice(0, split.start), lines[split.start] as string, ''];
  if (preamble.length > 0) out.push(...preamble, '');
  sections.forEach((s, i) => {
    if (i > 0) out.push('');
    out.push(s.headingLine, '', ...s.lines);
  });
  if (tail.length > 0) out.push('', ...tail);
  const merged = out.join(eol) + (trailing || tail.length === 0 ? eol : '');

  // Guard: nothing outside the block moved, and the result is still a file the release commit can read.
  const after = linesOf(merged);
  const splitAfter = splitUnreleased(merged);
  const sameHead =
    after.lines.slice(0, split.start + 1).join('\n') === lines.slice(0, split.start + 1).join('\n');
  const sameTail = splitAfter !== null && after.lines.slice(splitAfter.end).join('\n') === tail.join('\n');
  if (!sameHead || !sameTail || checkChangelog(merged).errors.length > 0)
    return { kind: 'error', message: 'internal: merge would change text outside Unreleased' };
  return { kind: 'merged', md: merged, added, duplicates };
}
