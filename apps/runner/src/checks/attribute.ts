import { posix } from 'node:path';

/**
 * Which output lines of a check name a file of the repository, grouped into files this card changed (`introduced`) and other
 * files (`elsewhere`). Both block a handoff since the whole-repository checks (the grouping only tells the agent where to
 * look); each finding also carries the paths it names, so the caller can tell which role may fix it. One run on the card's
 * head. Pure: the caller gives the changed set and a file-exists test.
 */

export interface AttributeOptions {
  /** The suite's folder relative to the repository (`.` for the root). */
  cwd: string;
  /** Repository-relative paths the card changed. */
  changed: ReadonlySet<string>;
  /** Does this repository-relative path exist in the worktree? */
  exists: (rel: string) => boolean;
  /** The command line (to see whether a recursive run could stop at its first failing package). */
  argv: readonly string[];
  /** Absolute path of the worktree: absolute paths in the output are made relative to it. */
  worktree?: string;
  /** The capture hit its size cap: the output is incomplete. */
  capped?: boolean;
}

/** One output line that names files of the repository. */
export interface Finding {
  line: string;
  /** The repository-relative paths the line names (changed or existing). */
  paths: string[];
  /** It names a file this card changed. */
  changed: boolean;
}

export interface Attribution {
  /** Every finding, in output order (complete; the lists below are capped). */
  findings: Finding[];
  introduced: string[];
  elsewhere: string[];
  introducedCount: number;
  elsewhereCount: number;
  /** Why this output cannot be judged completely (hint included). */
  incomplete?: string;
  /**
   * Output lines that look like a diagnostic location (`file.ts:12:3`, `file.ts(12,3)`) but name no file of the repository
   * the runner could match (a path with spaces, an unresolved prefix): such a finding cannot be given to another role.
   */
  unattributed: number;
}

const LIST_MAX = 20;
const LINE_MAX = 300;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
// path characters include `[ ] ( )` for route folders such as `[id].tsx` and `(group)/`
const TOKEN = /(?:[A-Za-z]:)?[\w@.+\-/\\[\]()]+\.[A-Za-z0-9]{1,8}(?=[:(\s]|$)/g;
/** A diagnostic location: `<name>.<ext>:<line>[:<col>]` or `<name>.<ext>(<line>,<col>)`. */
const LOCATION = /\S\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?\b|\(\d+,\d+\))/;
/**
 * A source code frame line under a diagnostic (Biome and friends: `> 12 │ code`, `13 │ code`, `│   ^^^`): it shows code, so
 * a URL with a port or a `foo.ts:12` comment in it is not a diagnostic location.
 */
const CODE_FRAME = /^(?:>\s*)?[\d\s]*[│|]|^[\^~]+(?:\s|$)/;
const PNPM_PREFIX = /^(\S+) [\w:-]+: /;
/** An http(s) URL: never a file reference or a diagnostic location (`127.0.0.1:3000` is not `file:line`). */
const WEB_URL = /\bhttps?:\/\/\S*/gi;
/** The location tail after a path: `:12`, `:12:3`, `(12,3)` and the rest of the line. */
const LOC_TAIL = /(?::\d+(?::\d+)?|\(\d+,\d+\))(?:[:\s].*)?$/;
/** Ends like a file name with an extension. */
const PATH_END = /\S\.[A-Za-z0-9]{1,8}$/;

export const stripAnsi = (s: string): string => s.replace(ANSI, '');

const clean = (p: string): string => {
  const n = posix.normalize(p.replace(/\\/g, '/').replace(/^\.\//, ''));
  return n.replace(/^\.\//, '');
};

export function attribute(output: string, o: AttributeOptions): Attribution {
  const introduced = new Set<string>();
  const elsewhere = new Set<string>();
  const findings = new Map<string, Finding>();
  let unattributed = 0;
  const wt = o.worktree ? `${o.worktree.replace(/\\/g, '/').replace(/\/+$/, '')}/` : null;
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const pm = PNPM_PREFIX.exec(line);
    const prefix = pm?.[1];
    const prefixDir = prefix && o.exists(clean(prefix)) ? clean(prefix) : null;
    // `<package> <script>: ` from pnpm -r, not a `file:line: error:` location (mypy, gcc)
    const body =
      pm?.[1] && !pm[1].endsWith(':') && !LOCATION.test(pm[1]) ? line.slice(pm[0].length).trim() : line;
    if (CODE_FRAME.test(body)) continue;
    const text = line.replace(WEB_URL, ' ');
    let hitIntroduced = false;
    let hitElsewhere = false;
    const paths = new Set<string>();
    const locate = (token: string): { path: string; changed: boolean } | null => {
      const candidates: string[] = [];
      if (wt && token.startsWith(wt)) candidates.push(clean(token.slice(wt.length)));
      else if (!/^([A-Za-z]:)?\//.test(token)) {
        if (prefixDir) candidates.push(clean(`${prefixDir}/${token}`));
        if (o.cwd && o.cwd !== '.') candidates.push(clean(`${o.cwd}/${token}`));
        candidates.push(clean(token));
      }
      const changedHit = candidates.find((c) => o.changed.has(c));
      if (changedHit) return { path: changedHit, changed: true };
      const existing = candidates.find((c) => c && !c.startsWith('..') && o.exists(c));
      return existing ? { path: existing, changed: false } : null;
    };
    const record = (hit: { path: string; changed: boolean }): void => {
      if (hit.changed) hitIntroduced = true;
      else hitElsewhere = true;
      paths.add(hit.path);
    };
    // a line that is one path with spaces (bare, stylish header, or with a location tail)
    const whole = body.replace(WEB_URL, ' ').trim().replace(LOC_TAIL, '').trim().replace(/\\/g, '/');
    const wholeHit = whole.includes(' ') && PATH_END.test(whole) ? locate(whole) : null;
    if (wholeHit) record(wholeHit);
    else
      for (const m of text.matchAll(TOKEN)) {
        const hit = locate(m[0].replace(/\\/g, '/'));
        if (hit) record(hit);
      }
    const shown = line.slice(0, LINE_MAX);
    if (hitIntroduced) introduced.add(shown);
    else if (hitElsewhere) elsewhere.add(shown);
    if (!hitIntroduced && !hitElsewhere && LOCATION.test(text)) unattributed++;
    if ((hitIntroduced || hitElsewhere) && !findings.has(shown))
      findings.set(shown, { line: shown, paths: [...paths], changed: hitIntroduced });
  }
  const reasons: string[] = [];
  if (/Diagnostics not shown|exceeds the number allowed/i.test(output))
    reasons.push('the tool cut its output (add `--max-diagnostics=none`)');
  const recursive = o.argv.some((a) => a === '-r' || a === '--recursive');
  if (recursive && !o.argv.includes('--no-bail'))
    reasons.push('a recursive run stops at the first failing package (add `--no-bail`)');
  if (o.capped) reasons.push('the output was longer than the 2 MiB the runner keeps');
  return {
    findings: [...findings.values()],
    introduced: [...introduced].slice(0, LIST_MAX),
    elsewhere: [...elsewhere].slice(0, LIST_MAX),
    introducedCount: introduced.size,
    elsewhereCount: elsewhere.size,
    unattributed,
    ...(reasons.length ? { incomplete: reasons.join('; ') } : {}),
  };
}
