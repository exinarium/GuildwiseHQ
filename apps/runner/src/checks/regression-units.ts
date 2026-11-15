import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type IntegrationSuite, isSafeRelativeDir } from '@aom/shared';
import { readJunit } from '../testing/junit.ts';
import { stripAnsi } from './attribute.ts';
import { type CheckLaunch, capture } from './run.ts';
import { failingTestFiles } from './units.ts';

/**
 * The unit suites of a suite card (regression, full suite): the runner runs every confirmed unit suite of the repository
 * whole, one after the other, in the background while the tester runs the E2E suite, and reports each result itself
 * (`test.suite` with `kind: 'unit'`, `measured: true`). The tester runs no unit tests. `aom test pass` is refused while a
 * suite runs or failed; `aom test fail` gets a `Bug:` section per failing test file, so the server files one bug card per
 * file and records a rerun's same failure as seen again.
 */

export interface UnitSuiteRun {
  name: string;
  cwd: string;
  status: 'waiting' | 'running' | 'passed' | 'failed' | 'timeout' | 'error';
  /** Failing test files, relative to the repository. */
  failing: string[];
  summary: string;
  timeoutMin: number;
  startedAt?: number;
  durationMs?: number;
  log?: string;
}

export interface UnitSuiteReport {
  name: string;
  status: 'passed' | 'failed' | 'timeout';
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  failures: string[];
  kind: 'unit';
  measured: true;
  note?: string;
}

export interface RegressionUnitsInput {
  suites: readonly IntegrationSuite[];
  worktree: string;
  logDir: string;
  /** The run-step sandbox launch with the host network (the suites may reach a local database); may throw. */
  launch: (argv: string[], key: string) => Promise<CheckLaunch>;
  report: (r: UnitSuiteReport) => Promise<void>;
  signal?: AbortSignal;
  spawnImpl?: typeof nodeSpawn;
  now?: () => number;
}

export class RegressionUnits {
  readonly runs = new Map<string, UnitSuiteRun>();
  private done: Promise<void> | undefined;

  constructor(private readonly i: RegressionUnitsInput) {
    for (const s of i.suites)
      this.runs.set(s.name.toLowerCase(), {
        name: s.name,
        cwd: s.cwd,
        status: 'waiting',
        failing: [],
        summary: 'waiting to run',
        timeoutMin: s.timeoutMin,
      });
  }

  /** Is `name` one of the unit suites (the tester may not report it)? */
  isUnitSuite(name: string): boolean {
    return this.runs.has(name.trim().toLowerCase());
  }

  /** Runs the suites one after the other (once); resolves when all have a result. */
  start(): Promise<void> {
    this.done ??= this.runAll();
    return this.done;
  }

  private async runAll(): Promise<void> {
    const now = this.i.now ?? Date.now;
    try {
      mkdirSync(this.i.logDir, { recursive: true });
    } catch {
      // the log is a convenience
    }
    for (const suite of this.i.suites) {
      const run = this.runs.get(suite.name.toLowerCase()) as UnitSuiteRun;
      run.status = 'running';
      run.summary = 'running';
      run.startedAt = now();
      const finish = async (
        status: UnitSuiteRun['status'],
        summary: string,
        extra: Partial<UnitSuiteReport> = {},
      ) => {
        run.status = status;
        run.summary = summary;
        run.durationMs = Math.max(0, now() - (run.startedAt ?? now()));
        await this.i
          .report({
            name: suite.name,
            status: status === 'passed' ? 'passed' : status === 'timeout' ? 'timeout' : 'failed',
            passed: 0,
            failed: run.failing.length,
            skipped: 0,
            durationMs: run.durationMs,
            failures: run.failing.slice(0, 10).map((f) => f.slice(0, 300)),
            kind: 'unit',
            measured: true,
            ...(status === 'error' ? { note: `could not run: ${summary}`.slice(0, 2000) } : {}),
            ...extra,
          })
          .catch(() => undefined);
      };
      if (!isSafeRelativeDir(suite.cwd)) {
        await finish('error', 'the folder must stay inside the repository');
        continue;
      }
      if (this.i.signal?.aborted) {
        await finish('error', 'the shift ended before it ran');
        continue;
      }
      let l: CheckLaunch;
      try {
        l = await this.i.launch(suite.cmd, `unit-${suite.name}`);
      } catch (err) {
        await finish('error', (err instanceof Error ? err.message : String(err)).slice(0, 400));
        continue;
      }
      const cwd = resolve(this.i.worktree, suite.cwd);
      const c = await capture(
        l,
        cwd,
        suite.timeoutMin * 60_000,
        this.i.signal,
        this.i.spawnImpl ?? nodeSpawn,
      );
      const logPath = join(this.i.logDir, `unit-${suite.name.replace(/[^A-Za-z0-9._-]+/g, '-')}.log`);
      try {
        writeFileSync(logPath, c.output);
        run.log = logPath;
      } catch {
        // not fatal
      }
      const prefix = suite.cwd && suite.cwd !== '.' ? `${suite.cwd.replace(/\/+$/, '')}/` : '';
      run.failing = failingTestFiles(stripAnsi(c.output)).map((f) => `${prefix}${f}`);
      let counts: Partial<UnitSuiteReport> = {};
      if (suite.junit) {
        try {
          const j = readJunit(cwd, suite.junit);
          counts = { passed: j.passed, failed: j.failed, skipped: j.skipped };
        } catch {
          // no report: the output's FAIL lines count
        }
      }
      if (c.aborted) await finish('error', 'stopped: the shift ended');
      else if (c.spawnError !== undefined) await finish('error', `could not start: ${c.spawnError}`);
      else if (c.timedOut) await finish('timeout', `timed out after ${suite.timeoutMin} minutes`, counts);
      else if (c.exitCode === 0) await finish('passed', 'passed', counts);
      else if (run.failing.length)
        await finish('failed', `${run.failing.length} test file(s) failing`, counts);
      else await finish('error', `exit ${c.exitCode ?? '?'} without naming a failing test file`, counts);
    }
  }

  /** Why `aom test pass` must wait or fail, or null when every unit suite passed. */
  passProblem(): string | null {
    const now = this.i.now ?? Date.now;
    const pending = [...this.runs.values()].filter((r) => r.status === 'waiting' || r.status === 'running');
    if (pending.length) {
      const left = pending.reduce((sum, r) => {
        const used = r.status === 'running' && r.startedAt ? (now() - r.startedAt) / 60_000 : 0;
        return sum + Math.max(1, r.timeoutMin - used);
      }, 0);
      return `the runner is still running the unit suites (${pending.map((r) => r.name).join(', ')}): at most about ${Math.ceil(left)} min left. Run \`aom test pass\` again when they are done.`;
    }
    const bad = [...this.runs.values()].filter((r) => r.status !== 'passed');
    if (bad.length)
      return `unit ${bad.length === 1 ? 'suite' : 'suites'} ${bad.map((r) => `${r.name} (${r.status}: ${r.summary})`).join('; ')} did not pass: report it with \`aom test fail\` (the runner adds a bug section per failing test file).`;
    return null;
  }

  /** The `Bug:` sections `aom test fail` gets: one per failing test file, one per suite that could not run. */
  failSections(): string {
    const out: string[] = [];
    for (const r of this.runs.values()) {
      if (r.status === 'passed' || r.status === 'waiting' || r.status === 'running') continue;
      if (r.status === 'failed' && r.failing.length) {
        for (const f of r.failing)
          out.push(
            `Bug: Unit tests fail in ${f} (${r.name})\nTest: unit:${r.name}:${f}\nThe runner ran the unit suite "${r.name}" whole on this suite card; ${f} fails.${r.log ? ` Full output on the workstation: ${r.log}` : ''}`,
          );
      } else
        out.push(
          `Bug: Unit suite ${r.name} did not produce a result (${r.status})\nTest: unit:${r.name}:error\n${r.summary}${r.log ? `\nFull output on the workstation: ${r.log}` : ''}`,
        );
    }
    return out.join('\n\n');
  }
}
