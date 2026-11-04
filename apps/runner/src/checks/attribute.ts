import { posix } from 'node:path';

/**
 * Which output lines of a check name a file this card changed (introduced: they block the handoff) and which name only
 * other existing files (elsewhere: information). One run on the card's head, attribution by file (docs: the 1.5.0 design of
 * the builder handoff checks). Pure: the caller gives the changed set and a file-exists test.
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

export interface Attribution {
  introduced: string[];
  elsewhere: string[];
  introducedCount: number;
  elsewhereCount: number;
  /** Why this output cannot be judged completely (hint included); the check is then a warning, not a block. */
  incomplete?: string;
}

const LIST_MAX = 20;
const LINE_MAX = 300;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const TOKEN = /(?:[A-Za-z]:)?[\w@.+\-/\\]+\.[A-Za-z0-9]{1,8}(?=[:(\s]|$)/g;
const PNPM_PREFIX = /^(\S+) [\w:-]+: /;

export const stripAnsi = (s: string): string => s.replace(ANSI, '');

const clean = (p: string): string => {
  const n = posix.normalize(p.replace(/\\/g, '/').replace(/^\.\//, ''));
  return n.replace(/^\.\//, '');
};

export function attribute(output: string, o: AttributeOptions): Attribution {
  const introduced = new Set<string>();
  const elsewhere = new Set<string>();
  const wt = o.worktree ? `${o.worktree.replace(/\\/g, '/').replace(/\/+$/, '')}/` : null;
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const prefix = PNPM_PREFIX.exec(line)?.[1];
    const prefixDir = prefix && o.exists(clean(prefix)) ? clean(prefix) : null;
    let hitIntroduced = false;
    let hitElsewhere = false;
    for (const m of line.matchAll(TOKEN)) {
      const token = m[0].replace(/\\/g, '/');
      const candidates: string[] = [];
      if (wt && token.startsWith(wt)) candidates.push(clean(token.slice(wt.length)));
      else if (!/^([A-Za-z]:)?\//.test(token)) {
        if (prefixDir) candidates.push(clean(`${prefixDir}/${token}`));
        if (o.cwd && o.cwd !== '.') candidates.push(clean(`${o.cwd}/${token}`));
        candidates.push(clean(token));
      }
      if (candidates.some((c) => o.changed.has(c))) hitIntroduced = true;
      else if (candidates.some((c) => c && !c.startsWith('..') && o.exists(c))) hitElsewhere = true;
    }
    const shown = line.slice(0, LINE_MAX);
    if (hitIntroduced) introduced.add(shown);
    else if (hitElsewhere) elsewhere.add(shown);
  }
  const reasons: string[] = [];
  if (/Diagnostics not shown|exceeds the number allowed/i.test(output))
    reasons.push('the tool cut its output (add `--max-diagnostics=none`)');
  const recursive = o.argv.some((a) => a === '-r' || a === '--recursive');
  if (recursive && !o.argv.includes('--no-bail'))
    reasons.push('a recursive run stops at the first failing package (add `--no-bail`)');
  if (o.capped) reasons.push('the output was longer than the 2 MiB the runner keeps');
  return {
    introduced: [...introduced].slice(0, LIST_MAX),
    elsewhere: [...elsewhere].slice(0, LIST_MAX),
    introducedCount: introduced.size,
    elsewhereCount: elsewhere.size,
    ...(reasons.length ? { incomplete: reasons.join('; ') } : {}),
  };
}
