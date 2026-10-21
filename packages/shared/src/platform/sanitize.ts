/**
 * Sanitising for diagnostics that leave a machine or an organisation (Lean Team v3 platform team). The runner uses it
 * for `runner.error`; the server uses the same functions for its own 5xx errors and for the bug cards it files for client
 * organisations, so one definition of "safe to show the platform team" exists. Pure string functions: no node imports
 * (the web app imports this package too).
 */

const SECRET =
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|\b(sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|aomr_[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,}|xox[abp]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const KEYED_SECRET =
  /((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|authorization)[\w-]*["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi;
const URL_CREDENTIALS = /(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** An absolute path: keeps only the last two segments (`/home/u/.aom-runner/worktrees/X/y.ts` -> `…/X/y.ts`). */
const ABS_PATH = /(?:[A-Za-z]:)?(?:[\\/][^\s"'`()<>:,;|]+){2,}/g;

/** Masks paths, ids, secrets, credentials in URLs and e-mail addresses. `home` (when given) becomes `~`. */
export function maskText(text: string, home?: string): string {
  let t = text;
  if (home && home.length > 1) t = t.split(home).join('~');
  return t
    .replace(URL_CREDENTIALS, '$1***@')
    .replace(SECRET, '***')
    .replace(KEYED_SECRET, '$1***')
    .replace(EMAIL, '<email>')
    .replace(UUID, '<id>')
    .split('\n')
    .map(shortenPaths)
    .join('\n');
}

/**
 * Shortens the absolute paths of one line. A lone path keeps its last two segments. When a line holds several different paths
 * (a message that compares two files) only the leading segments they SHARE are dropped, so the part that differs always shows:
 * `/home/u/src/a/deploy/local/f.yml` vs `/home/u/src/b/deploy/local/f.yml` -> `…/a/deploy/local/f.yml`, `…/b/deploy/local/f.yml`.
 */
function shortenPaths(line: string): string {
  const found = [...line.matchAll(ABS_PATH)].map((m) => m[0].split(/[\\/]/).filter(Boolean));
  const distinct = new Set(found.map((p) => p.join('/')));
  let common = 0;
  if (distinct.size > 1) {
    const first = found[0] ?? [];
    while (found.every((p) => p.length > common + 1 && p[common] === first[common])) common++;
    // always show the last two segments, and never drop the segment that differs
    common = Math.min(common, ...found.map((p) => Math.max(0, p.length - 2)));
  }
  return line.replace(ABS_PATH, (p) => {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return `…/${(distinct.size > 1 ? parts.slice(common) : parts.slice(-2)).join('/')}`;
  });
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** `at fn (/abs/dir/file.ts:12:3)` -> `at fn (file.ts:12:3)`; frames that are not code locations are dropped. */
export function sanitizeStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const lines = stack
    .split('\n')
    .slice(1) // the first line repeats the message
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '))
    .slice(0, 20)
    .map((l) => {
      const m = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(l);
      if (!m) return maskText(l).slice(0, 160);
      const file = baseName(m[2] ?? '').replace(/^file:\/\//, '');
      return `at ${m[1] ? `${m[1]} ` : ''}(${file}:${m[3]}:${m[4]})`;
    });
  return lines.length > 0 ? lines.join('\n').slice(0, 5000) : undefined;
}

export interface StackFrame {
  fn: string;
  file: string;
}

/** The top frames of a stack as function plus file basename (no line numbers, no directories). */
export function topFrames(stack: string | undefined, n = 5): StackFrame[] {
  if (!stack) return [];
  const out: StackFrame[] = [];
  for (const raw of stack.split('\n')) {
    const l = raw.trim();
    if (!l.startsWith('at ')) continue;
    const m = /^at (?:(.+?) \()?(.+?)(?::\d+){0,2}\)?$/.exec(l);
    if (!m) continue;
    out.push({
      fn: maskText(m[1] ?? '(anonymous)').slice(0, 80),
      file: baseName(m[2] ?? '')
        .replace(/^file:\/\//, '')
        .replace(/\?.*$/, '')
        .slice(0, 80),
    });
    if (out.length >= n) break;
  }
  return out;
}
