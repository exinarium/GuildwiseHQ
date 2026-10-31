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
