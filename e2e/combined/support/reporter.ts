import { writeFileSync } from 'node:fs';
import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { E2E_DIR } from '../../support/env.ts';
import { idsInTitle, SCENARIOS } from './scenarios.ts';

type Seen = { passed: number; failed: number; skipped: number; notes: string[]; owner: string[] };

/** One line per scenario id. A missing `auto` id is a FAIL. Exit code comes from Playwright (any failed test). */
export default class ScenarioReporter implements Reporter {
  private readonly seen = new Map<string, Seen>();
  private filtered = false;

  onBegin(config: FullConfig): void {
    // a --grep or a file argument runs a subset: ids outside it are NOT RUN, not FAIL
    this.filtered =
      String(config.grep) !== String(/.*/) ||
      process.argv.some((a) => /\.spec\.ts|--grep|-g$|--project/.test(a));
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    for (const id of idsInTitle(test.title)) {
      const s = this.seen.get(id) ?? { passed: 0, failed: 0, skipped: 0, notes: [], owner: [] };
      if (result.status === 'passed') s.passed++;
      else if (result.status === 'skipped') {
        s.skipped++;
        const a = test.annotations.find((x) => x.type === 'owner-machine');
        if (a) s.owner.push(a.description ?? 'owner/machine');
      } else {
        s.failed++;
        s.notes.push(
          `${test.title}: ${(result.error?.message ?? result.status).split('\n')[0]?.slice(0, 160)}`,
        );
      }
      this.seen.set(id, s);
    }
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    const lines: string[] = [];
    let red = 0;
    for (const [id, h] of Object.entries(SCENARIOS)) {
      const s = this.seen.get(id);
      let verdict: string;
      if (h.kind === 'auto') {
        if (!s && this.filtered) verdict = 'NOT RUN (filtered run)';
        else if (!s) verdict = 'FAIL    (no test reported this id)';
        else if (s.failed > 0) verdict = `FAIL    ${s.notes[0] ?? ''}`;
        else if (s.passed === 0 && s.owner.length) verdict = `OWNER-MACHINE  ${s.owner[0]}`;
        else if (s.passed === 0) verdict = 'FAIL    (skipped, nothing passed)';
        else verdict = `PASS    (${s.passed} check${s.passed === 1 ? '' : 's'})`;
        if (verdict.startsWith('FAIL')) red++;
      } else if (h.kind === 'owner') verdict = `OWNER-MACHINE  ${h.reason}`;
      else if (h.kind === 'pending') verdict = `PENDING        waits for ${h.build}`;
      else verdict = `COVERED-BY     ${h.by}`;
      lines.push(`${id.padEnd(12)} ${verdict.padEnd(12)}  ${h.title}`);
    }
    const text = `\nCombined e2e, per scenario\n${lines.join('\n')}\n\n${red} scenario(s) FAIL; playwright status: ${result.status}\n`;
    process.stdout.write(text);
    try {
      writeFileSync(`${E2E_DIR}-combined-summary.txt`, text);
    } catch {
      // the table on screen is the report
    }
    // a missing id (crash, typo) fails the run even when every test that did run passed
    return red > 0 && result.status === 'passed' ? { status: 'failed' } : undefined;
  }
}
