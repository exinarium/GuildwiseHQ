import { isValidReportPath } from '../cards/fields.ts';
import { slugify } from '../ids.ts';

/**
 * Investigate & design (docs/design/architect-and-workflows.md section 3.4): where the architect's report goes, and
 * the helpers the server (brief, `PROJECT.md` section) and the runner (guard, vault copy, secret scan) share.
 */

export const INVESTIGATION_DEFAULT_PATH = 'docs/investigations';
/** Managed section of the project's `PROJECT.md` listing the recorded investigations. */
export const INVESTIGATIONS_SECTION_ID = 'investigations';

export type InvestigationLocation = 'repo' | 'vault';

export interface ReportTarget {
  location: InvestigationLocation;
  /**
   * `repo`: the path of the report file inside the card's worktree. `vault`: the path of the report file below the
   * project's folder in the knowledge vault (the architect writes the file into its scratch directory under the same
   * name and the runner copies it).
   */
  reportPath: string;
  /** The folder the architect may write documents in (the folder of `reportPath`). */
  folder: string;
}

export const reportFileName = (ref: string, title: string): string =>
  `${ref.toUpperCase()}-${slugify(title, 50) || 'investigation'}.md`;

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * The report location of a card, in order of precedence: the card's `fields.reportPath`, then the project's
 * `investigation_path` and `investigation_location`, then `docs/investigations` in the card's repository. A path that
 * ends in `.md` names the file; anything else is a folder and the file is named `<REF>-<slug>.md`. A `vault:` prefix on
 * the card's path selects the vault. Invalid paths fall through to the next source.
 */
export function resolveReportTarget(input: {
  cardReportPath?: unknown;
  projectPath?: string | null;
  projectLocation?: string | null;
  ref: string;
  title: string;
}): ReportTarget {
  const file = reportFileName(input.ref, input.title);
  const place = (raw: string, location: InvestigationLocation): ReportTarget => {
    const clean = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    const isFile = /\.md$/i.test(clean);
    const reportPath = isFile ? clean : clean ? `${clean}/${file}` : file;
    return { location, reportPath, folder: isFile ? dirOf(clean) : clean };
  };
  const card = typeof input.cardReportPath === 'string' ? input.cardReportPath.trim() : '';
  if (card && isValidReportPath(card))
    return card.startsWith('vault:') ? place(card.slice('vault:'.length), 'vault') : place(card, 'repo');
  const project = input.projectPath?.trim() ?? '';
  const location: InvestigationLocation = input.projectLocation === 'vault' ? 'vault' : 'repo';
  if (project && isValidReportPath(project) && !project.startsWith('vault:')) return place(project, location);
  return place(INVESTIGATION_DEFAULT_PATH, location);
}

// ------------------------------------------------------------------------------------------------ secrets

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['a private key block', /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['an AWS access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['an API secret key (sk-...)', /\bsk-[A-Za-z0-9_-]{24,}\b/],
  ['a JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  [
    'a credential assignment',
    /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{16,}/i,
  ],
];

/** What looks like a secret in a report: labels only, never the matched text. Empty: nothing obvious. */
export function scanReportForSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

// ------------------------------------------------------------------------------------------ PROJECT.md index

export interface InvestigationIndexEntry {
  cardRef: string;
  title: string;
  /** The report: a repository path, or a vault path. */
  reportPath: string;
  location: InvestigationLocation;
  recordedAt: string;
  decision: boolean;
  /** One line of the result. */
  summary: string;
}

const oneLine = (s: string, max = 200): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The `investigations` managed section of `PROJECT.md`. Pure: the same input yields the same text. */
export function renderInvestigationsIndex(
  entries: readonly InvestigationIndexEntry[],
  opts: { folder?: string } = {},
): string {
  const lines = [
    '## Investigations',
    '',
    'Investigations the architect did for this project; read them before you start.',
    '',
  ];
  if (entries.length === 0) lines.push('_No investigation was recorded yet._', '');
  const prefix = opts.folder ? `${opts.folder}/` : '';
  for (const e of [...entries].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
    const rel =
      e.location === 'vault' && prefix && e.reportPath.startsWith(prefix)
        ? e.reportPath.slice(prefix.length)
        : e.reportPath;
    const where =
      e.location === 'vault' ? `[${rel}](${rel.replace(/ /g, '%20')})` : `\`${rel}\` (in the repository)`;
    lines.push(
      `- ${e.cardRef} ${oneLine(e.title, 120).replace(/[[\]]/g, '')}${e.decision ? ' (decision)' : ''}: ${where}, ${e.recordedAt.slice(0, 10)}. ${oneLine(e.summary)}`,
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
