import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';

/**
 * JUnit XML reports (what Playwright, Vitest, pytest, dotnet and Maven write) reduced to counts. `aom test suite
 * --junit <glob>` reads them so the tester does not have to count (docs/design/run-and-integration-tests.md 4.6).
 * A small scanner instead of an XML library: it only needs the `testcase` elements and what is inside them.
 */

export interface JunitCounts {
  passed: number;
  failed: number;
  skipped: number;
  /** Seconds, summed over the test cases that carry a `time`. */
  seconds: number;
  /** Names of the first failing cases ("suite > case"), for the card's table. */
  failures: string[];
  files: number;
}

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  const v = m?.[2] ?? m?.[3];
  return v === undefined ? undefined : decode(v);
}

/** Counts the test cases of one report: a case with a failure or error child failed, one with a skipped child was skipped. */
export function parseJunit(xml: string): JunitCounts {
  const out: JunitCounts = { passed: 0, failed: 0, skipped: 0, seconds: 0, failures: [], files: 1 };
  // <testcase .../> (self-closing) or <testcase ...> ... </testcase>
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const head = m[1] ?? '';
    const body = m[3] ?? '';
    const time = Number.parseFloat(attr(head, 'time') ?? '');
    if (Number.isFinite(time)) out.seconds += time;
    const failed = /<(failure|error)\b/.test(body);
    const skipped = !failed && /<skipped\b/.test(body);
    if (failed) {
      out.failed++;
      if (out.failures.length < 10) {
        const cls = attr(head, 'classname');
        const name = attr(head, 'name') ?? '(unnamed)';
        out.failures.push(cls ? `${cls} > ${name}` : name);
      }
    } else if (skipped) out.skipped++;
    else out.passed++;
  }
  return out;
}

function walk(dir: string, depth: number, found: string[], limit: number): void {
  if (depth > 12 || found.length >= limit) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (n === 'node_modules' || n === '.git') continue;
    const p = join(dir, n);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, depth + 1, found, limit);
    else found.push(p);
    if (found.length >= limit) return;
  }
}

/**
 * The report files a glob (relative to `cwd`) names, never outside `cwd` (symlinks resolved). At most `limit` files; a
 * pattern with no wildcard names exactly one file.
 */
export function findJunitFiles(cwd: string, pattern: string, limit = 200): string[] {
  const root = realpathSync(cwd);
  if (pattern.startsWith('/') || pattern.split(/[\\/]/).includes('..'))
    throw new Error('the report path must be relative to the folder you run in and cannot use ".."');
  const isMatch = picomatch(pattern.replace(/^\.\//, ''), { dot: true });
  const all: string[] = [];
  walk(root, 0, all, 20000);
  const hits: string[] = [];
  for (const f of all) {
    const rel = relative(root, f).split(sep).join('/');
    if (!isMatch(rel)) continue;
    let real: string;
    try {
      real = realpathSync(f);
    } catch {
      continue;
    }
    if (real !== root && !real.startsWith(root + sep)) continue;
    hits.push(resolve(f));
    if (hits.length >= limit) break;
  }
  return hits.sort();
}

/** Reads every report the glob names and adds the counts up. Throws when no file matches or none is a JUnit report. */
export function readJunit(cwd: string, pattern: string): JunitCounts {
  const files = findJunitFiles(cwd, pattern);
  if (files.length === 0) throw new Error(`no report matches "${pattern}" in ${cwd}`);
  const total: JunitCounts = { passed: 0, failed: 0, skipped: 0, seconds: 0, failures: [], files: 0 };
  for (const f of files) {
    const xml = readFileSync(f, 'utf8');
    if (!/<testsuites?\b|<testcase\b/.test(xml)) continue;
    const c = parseJunit(xml);
    total.files++;
    total.passed += c.passed;
    total.failed += c.failed;
    total.skipped += c.skipped;
    total.seconds += c.seconds;
    for (const x of c.failures) if (total.failures.length < 10) total.failures.push(x);
  }
  if (total.files === 0) throw new Error(`"${pattern}" matched files, but none is a JUnit report`);
  return total;
}
