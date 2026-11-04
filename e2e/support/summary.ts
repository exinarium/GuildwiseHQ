import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR } from './env.ts';

type Suite = { specs?: Spec[]; suites?: Suite[] };
type Spec = {
  title: string;
  file: string;
  line: number;
  tests: { projectName: string; results: { status: string }[] }[];
};
type Report = {
  config?: { metadata?: { excludedProjects?: { name: string; reason: string }[] } };
  suites?: Suite[];
  stats?: { duration?: number };
};

export type Summary = {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  didNotRun: number;
  durationMin: number;
  failedTitles: string[];
  didNotRunByProject: Record<string, number>;
  notRunHere: string[];
};

export function summarize(report: Report): Summary {
  const s: Summary = {
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    didNotRun: 0,
    durationMin: Math.round(((report.stats?.duration ?? 0) / 60000) * 10) / 10,
    failedTitles: [],
    didNotRunByProject: {},
    notRunHere: [],
  };
  const walk = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        const statuses = t.results.map((r) => r.status);
        const last = statuses[statuses.length - 1];
        if (!last) {
          s.didNotRun++;
          s.didNotRunByProject[t.projectName] = (s.didNotRunByProject[t.projectName] ?? 0) + 1;
        } else if (last === 'skipped') s.skipped++;
        else if (last === 'passed') {
          if (statuses.length > 1) s.flaky++;
          s.passed++;
        } else {
          s.failed++;
          s.failedTitles.push(`${t.projectName}: ${spec.title} (${spec.file}:${spec.line})`);
        }
      }
    }
    for (const c of suite.suites ?? []) walk(c);
  };
  for (const suite of report.suites ?? []) walk(suite);
  for (const p of report.config?.metadata?.excludedProjects ?? [])
    s.notRunHere.push(`not run here: ${p.name} (${p.reason})`);
  return s;
}

export function formatSummary(s: Summary): string {
  const lines = [
    `passed ${s.passed}, failed ${s.failed}, skipped ${s.skipped}, did not run ${s.didNotRun}, flaky ${s.flaky}, duration ${s.durationMin} min`,
  ];
  if (s.failedTitles.length) lines.push('failed:', ...s.failedTitles.map((t) => `  ${t}`));
  const dnr = Object.entries(s.didNotRunByProject);
  if (dnr.length) lines.push('did not run per project:', ...dnr.map(([p, n]) => `  ${p}: ${n}`));
  lines.push(...s.notRunHere);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file =
    process.argv.find((a) => a.endsWith('.json') && !a.endsWith('summary.json')) ??
    join(RESULTS_DIR, 'results.json');
  const s = summarize(JSON.parse(readFileSync(file, 'utf8')) as Report);
  console.log(process.argv.includes('--json') ? JSON.stringify(s, null, 2) : formatSummary(s));
}
