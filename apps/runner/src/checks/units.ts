import { posix } from 'node:path';
import { FILES_TOKEN, type IntegrationSuite } from '@aom/shared';

/** More changed files than this in one suite: its whole command runs instead (within the handoff time limit). */
export const UNIT_FILES_MAX = 200;

export interface UnitRun {
  suite: IntegrationSuite;
  /** The command line to run (the handoff command with the files, or the whole suite). */
  argv: string[];
  /** The files given to it, relative to the suite's folder (empty for a whole-suite run). */
  files: string[];
  /** The whole suite runs (more than `UNIT_FILES_MAX` files). */
  whole: boolean;
}

const norm = (p: string): string => posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\/|\/+$/g, '');

/**
 * Which unit tests a builder's handoff runs ("keep it at files changed"): per confirmed unit suite with a handoff command,
 * the card's changed paths that still exist at the head and lie in the suite's folder (a path in nested suite folders
 * belongs to the deepest one), relative to that folder, in place of `{files}`. The project's runner finds the related tests
 * (`vitest related`, `jest --findRelatedTests`). A suite with no such path has nothing to run; a suite without a handoff
 * command is not here (it runs at regression). Dependents in other folders are left to regression.
 */
export function handoffUnitRuns(
  units: readonly IntegrationSuite[],
  changed: readonly string[],
  exists: (rel: string) => boolean,
): UnitRun[] {
  const withCmd = units.filter((u) => u.kind === 'unit' && u.handoffCmd?.length);
  const dirOf = (u: IntegrationSuite): string => {
    const d = norm(u.cwd || '.');
    return d === '.' ? '' : d;
  };
  const byPath = new Map<IntegrationSuite, string[]>();
  for (const raw of changed) {
    const p = norm(raw);
    if (!p || p.startsWith('..') || !exists(p)) continue;
    let best: IntegrationSuite | undefined;
    let bestLen = -1;
    for (const u of withCmd) {
      const d = dirOf(u);
      const inside = d === '' || p === d || p.startsWith(`${d}/`);
      if (inside && d.length > bestLen) {
        best = u;
        bestLen = d.length;
      }
    }
    if (!best) continue;
    const d = dirOf(best);
    const rel = d === '' ? p : posix.relative(d, p);
    if (!rel) continue;
    const list = byPath.get(best) ?? [];
    list.push(rel);
    byPath.set(best, list);
  }
  const out: UnitRun[] = [];
  for (const u of withCmd) {
    const files = byPath.get(u);
    if (!files?.length) continue;
    if (files.length > UNIT_FILES_MAX) {
      out.push({ suite: u, argv: [...u.cmd], files: [], whole: true });
      continue;
    }
    // `{files}` is a whole argument (validated with the settings): each file becomes one argument; a name that starts
    // with `-` is given as `./-name` so the test runner cannot read it as an option. An argument that only contains
    // the token (settings saved before the validation) is not run at handoff: the whole suite runs instead.
    const handoff = u.handoffCmd as string[];
    if (handoff.some((a) => a !== FILES_TOKEN && a.includes(FILES_TOKEN))) {
      out.push({ suite: u, argv: [...u.cmd], files: [], whole: true });
      continue;
    }
    const argv: string[] = [];
    for (const a of handoff) {
      if (a === FILES_TOKEN) argv.push(...files.map((f) => (f.startsWith('-') ? `./${f}` : f)));
      else argv.push(a);
    }
    out.push({ suite: u, argv, files, whole: false });
  }
  return out;
}

/** The failing test files a unit run's output names (`FAIL <file>` lines of vitest and jest), in order, once each. */
export function failingTestFiles(output: string): string[] {
  const out: string[] = [];
  for (const m of output.matchAll(/^\s*(?:[✗×❯]\s*)?FAIL\s+(?:\|[^|]*\|\s+)?(\S+?\.[cm]?[jt]sx?)\b/gm)) {
    const f = m[1] as string;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}
