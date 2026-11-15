import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CHECKS_BUDGET_MS,
  type CheckEvidence,
  checkStatusPasses,
  type IntegrationSuite,
  isSafeRelativeDir,
  UNIT_BUDGET_MS,
  UNIT_HANDOFF_TIMEOUT_MIN,
} from '@aom/shared';
import { type Attribution, attribute, type Finding, stripAnsi } from './attribute.ts';
import { failingTestFiles, handoffUnitRuns } from './units.ts';

/** The most output of one check the runner keeps in memory (the rest is dropped and the result says so). */
export const CHECK_OUTPUT_CAP = 2 * 1024 * 1024;
const REFUSAL_MAX = 8000;
const KILL_GRACE_MS = 2000;
const MISSING_TOOL =
  /command not found|: not found|ERR_PNPM_NO_SCRIPT|Missing script|is not recognized as an internal or external command|ENOENT/i;

export interface CheckLaunch {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  sandbox?: 'sandboxed' | 'off';
  /** Private tmp dir to remove afterwards (the caller does). */
  tmp?: string;
}

/** Which files the handing-off role may edit (the guard's own scope rules), and what to do about the rest. */
export interface CheckScope {
  /** May this role edit the repository-relative path? */
  mayEdit: (path: string) => boolean;
  /** The role that can fix a finding in a path this role may not edit. */
  ownerOf: (path: string) => string;
  /**
   * True (a builder): a check whose only findings are in files the role may not edit is `deferred` (owed by the owner, does
   * not block). False (a tester, a writer): it still refuses, and the refusal says who can fix it and how to report it.
   */
  defer: boolean;
  /** Tester or writer: how to hand a finding in a file it may not edit to the role that can fix it. */
  reportHint?: string;
}

export interface RunChecksInput {
  /** The confirmed checks (lint, format, typecheck) of the card's repository. */
  suites: readonly IntegrationSuite[];
  /** A builder's handoff: the confirmed unit suites (the tests of the changed files run, see `checks/units.ts`). */
  units?: readonly IntegrationSuite[];
  worktree: string;
  changedPaths: readonly string[];
  headSha: string;
  /** Where the full output of each check is written. */
  logDir: string;
  /** Builds the sandboxed command line; may throw (no sandbox, Docker): the check is then `error`. Absent: no check can run. */
  launch?: (argv: string[], key: string) => Promise<CheckLaunch>;
  signal?: AbortSignal;
  spawnImpl?: typeof nodeSpawn;
  now?: () => number;
  budgetMs?: number;
  unitBudgetMs?: number;
  /** Results by head and check, so a second `aom handoff` at the same head does not run them again (never `error`/`timeout`). */
  cache?: Map<string, { evidence: CheckEvidence; log: string }>;
  /** Absent: every file counts as the role's own (nothing is deferred). */
  scope?: CheckScope;
}

export interface RunChecksResult {
  evidence: CheckEvidence[];
  /** The checks that refuse the handoff: every status except passed, deferred and regression_only. */
  blocking: CheckEvidence[];
  /** The text that refuses the handoff (empty when nothing blocks). */
  refusal: string;
  /** One line for the accepted handoff: what ran. */
  summary: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'check';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export interface Captured {
  output: string;
  capped: boolean;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

function killGroup(
  child: { pid?: number; kill: (s?: NodeJS.Signals) => boolean },
  sig: NodeJS.Signals,
): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    // already gone
  }
}

/** Runs one launched command in `cwd` and collects its output (capped), with a timeout and an abort signal. */
export function capture(
  l: CheckLaunch,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  spawnImpl: typeof nodeSpawn,
): Promise<Captured> {
  return new Promise((resolveP) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let capped = false;
    let timedOut = false;
    let aborted = false;
    let done = false;
    let kill: NodeJS.Timeout | undefined;
    const finish = (c: Partial<Captured>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (kill) clearTimeout(kill);
      signal?.removeEventListener('abort', onAbort);
      resolveP({
        output: Buffer.concat(chunks).toString('utf8'),
        capped,
        exitCode: null,
        timedOut,
        aborted,
        ...c,
      });
    };
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawnImpl(l.cmd, l.args, {
        cwd,
        env: l.env,
        detached: process.platform !== 'win32',
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolveP({
        output: '',
        capped: false,
        exitCode: null,
        timedOut: false,
        aborted: false,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const stop = () => {
      killGroup(child, 'SIGTERM');
      kill = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
      kill.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
      // do not wait for a process that ignores the signals
      setTimeout(() => finish({}), KILL_GRACE_MS + 500).unref?.();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
      setTimeout(() => finish({}), KILL_GRACE_MS + 500).unref?.();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const onData = (b: Buffer) => {
      if (size >= CHECK_OUTPUT_CAP) {
        capped = true;
        return;
      }
      const room = CHECK_OUTPUT_CAP - size;
      const piece = b.length > room ? b.subarray(0, room) : b;
      if (b.length > room) capped = true;
      chunks.push(piece);
      size += piece.length;
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => finish({ spawnError: err.message }));
    child.on('close', (code) => finish({ exitCode: code }));
  });
}

/** The order the checks run in: format, lint, typecheck (quick checks first, so lint never gets a leftover budget). */
export function checkOrder(suite: Pick<IntegrationSuite, 'name' | 'cmd'>): number {
  const t = `${suite.name} ${suite.cmd.join(' ')}`.toLowerCase();
  if (/typecheck|type-check|check-types|\btsc\b|mypy/.test(t)) return 2;
  if (/format|\bfmt\b|prettier|\bblack\b|isort|gofmt/.test(t)) return 0;
  return 1;
}

const lastLines = (output: string, n = 20): string[] =>
  stripAnsi(output)
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n)
    .map((l) => l.slice(0, 300));

/** The first "X: not found" style line of the output, quoted in a missing-tool verdict. */
const missingLine = (output: string): string | undefined =>
  stripAnsi(output)
    .split(/\r?\n/)
    .find((l) => MISSING_TOOL.test(l))
    ?.trim()
    .slice(0, 200);

type Verdict = Pick<CheckEvidence, 'status' | 'summary'>;

/** What did not produce a verdict, or null when the run ended normally. */
function noVerdict(timeoutMin: number, c: Captured): Verdict | null {
  if (c.aborted) return { status: 'error', summary: 'stopped: the shift ended while the check was running' };
  if (c.spawnError !== undefined) {
    return /ENOENT/.test(c.spawnError)
      ? { status: 'error', summary: `missing tool: ${c.spawnError}`.slice(0, 500) }
      : { status: 'error', summary: `could not start: ${c.spawnError}`.slice(0, 500) };
  }
  if (c.timedOut) return { status: 'timeout', summary: `timed out after ${plural(timeoutMin, 'minute')}` };
  return null;
}

const missingTool = (c: Captured): Verdict => {
  const line = missingLine(c.output);
  return {
    status: 'error',
    summary: `missing tool or script: the command could not run here${line ? ` ("${line}")` : ` (exit ${c.exitCode ?? '?'})`}`,
  };
};

/**
 * A check's verdict: passed (exit 0), failed (any finding, in any file of the repository), timeout, or error (missing
 * tool, could not start, stopped, output incomplete with no findings, a non-zero exit naming no file).
 */
export function judge(suite: Pick<IntegrationSuite, 'timeoutMin'>, c: Captured, a: Attribution): Verdict {
  const nv = noVerdict(suite.timeoutMin, c);
  if (nv) return nv;
  if (c.exitCode === 0) return { status: 'passed', summary: 'passed' };
  const total = a.introducedCount + a.elsewhereCount;
  if (c.exitCode === 126 || c.exitCode === 127 || (total === 0 && MISSING_TOOL.test(c.output)))
    return missingTool(c);
  if (total > 0) {
    const parts = [
      ...(a.introducedCount ? [`${a.introducedCount} in files this card changed`] : []),
      ...(a.elsewhereCount ? [`${a.elsewhereCount} in other files`] : []),
    ];
    return { status: 'failed', summary: `${plural(total, 'problem')}: ${parts.join(', ')}` };
  }
  if (a.incomplete)
    return { status: 'error', summary: `the output is incomplete, so it cannot be judged: ${a.incomplete}` };
  return { status: 'error', summary: `failed (exit ${c.exitCode ?? '?'}) without naming a file` };
}

/** A unit run's verdict: passed (exit 0), failed (failing test files named), timeout, or error. */
export function judgeUnit(timeoutMin: number, c: Captured, failing: readonly string[]): Verdict {
  const nv = noVerdict(timeoutMin, c);
  if (nv) return nv;
  if (c.exitCode === 0) return { status: 'passed', summary: 'passed' };
  if (c.exitCode === 126 || c.exitCode === 127 || (failing.length === 0 && MISSING_TOOL.test(c.output)))
    return missingTool(c);
  if (failing.length > 0)
    return { status: 'failed', summary: `${plural(failing.length, 'test file')} failing` };
  if (/\b[1-9]\d* failed\b/i.test(c.output)) return { status: 'failed', summary: 'tests failed' };
  return { status: 'error', summary: `failed (exit ${c.exitCode ?? '?'}) without naming a failing test` };
}

const cmdText = (argv: readonly string[]): string => argv.join(' ').slice(0, 500);
const LIST_MAX = 20;

function refusalText(blocking: Array<{ ev: CheckEvidence; log: string }>, scope?: CheckScope): string {
  const parts: string[] = [];
  for (const { ev, log } of blocking) {
    const what = ev.kind === 'unit' ? 'the unit tests' : 'the check';
    const lines: string[] = [];
    if (ev.status === 'error' || ev.status === 'timeout') {
      lines.push(
        `${what} "${ev.name}" (\`${ev.command}\`) did not produce a verdict (${ev.status === 'timeout' ? 'timed out' : 'error'}): ${ev.summary}.`,
      );
      if (ev.tail?.length) lines.push('Last lines of its output:', ...ev.tail.map((l) => `  ${l}`));
    } else {
      lines.push(`${what} "${ev.name}" (\`${ev.command}\`) fails: ${ev.summary}.`);
      const inChanged = ev.introducedCount ?? ev.introduced.length;
      if (inChanged)
        lines.push(`In files this card changed (${inChanged}):`, ...ev.introduced.map((l) => `  ${l}`));
      if (ev.elsewhereCount)
        lines.push(`In other files (${ev.elsewhereCount}):`, ...ev.elsewhere.map((l) => `  ${l}`));
      if (ev.owed?.length && !scope?.defer) {
        lines.push(
          `Only a ${ev.owedBy ?? 'builder'} can fix these files (you may not edit them): ${ev.owed.length} problem(s), listed above.`,
        );
        if (scope?.reportHint) lines.push(scope.reportHint);
      }
    }
    if (ev.owed?.length && scope?.defer)
      lines.push(
        `Owed by the ${ev.owedBy ?? 'tester'} (does not block you, ${ev.owedCount ?? ev.owed.length}):`,
        ...ev.owed.map((l) => `  ${l}`),
      );
    if (ev.fix)
      lines.push(`Fix: \`${ev.fix}\` may repair formatting and imports: run it, review the diff, commit.`);
    if (log) lines.push(`Full output: ${log}`);
    parts.push(lines.join('\n'));
  }
  parts.push(
    [
      'Every lint, format and typecheck finding blocks, in any file of the repository, also in files you did not change. Fix them, commit, then run `aom handoff` again.',
      'If a check itself cannot run here (a missing tool, a broken environment), ask with `aom question --topic environment`, quoting this.',
      'Nothing was handed on.',
    ].join('\n'),
  );
  const text = parts.join('\n\n');
  return text.length <= REFUSAL_MAX
    ? text
    : `${text.slice(0, REFUSAL_MAX - 40)}\n[cut]\nNothing was handed on.`;
}

/** Splits a failed check's findings into the role's own and those it may not edit (owed by another role). */
function splitFindings(
  a: Attribution,
  scope: CheckScope | undefined,
): { own: Finding[]; owed: Finding[]; owedBy?: string } {
  if (!scope) return { own: a.findings, owed: [] };
  const own: Finding[] = [];
  const owed: Finding[] = [];
  const owners = new Set<string>();
  for (const f of a.findings) {
    const editable = f.paths.length === 0 || f.paths.some((p) => scope.mayEdit(p));
    if (editable) own.push(f);
    else {
      owed.push(f);
      for (const p of f.paths) owners.add(scope.ownerOf(p));
    }
  }
  return { own, owed, ...(owners.size ? { owedBy: [...owners].join(' or ') } : {}) };
}

/**
 * Runs the confirmed checks of the card's repository on the committed tree (the worktree, after the autocommit), one after
 * the other under a shared budget, in the order format, lint, typecheck; then a builder's unit test runs under their own
 * budget. Whole repository: a finding in any file refuses the handoff (findings are grouped by "this card changed" only to
 * guide the agent). A check that produced no verdict (error, timeout) refuses too. A builder's findings only in files it
 * may not edit (E2E test content) are `deferred`, owed by the tester.
 */
export async function runHandoffChecks(i: RunChecksInput): Promise<RunChecksResult> {
  const now = i.now ?? Date.now;
  const spawnImpl = i.spawnImpl ?? nodeSpawn;
  const changed = new Set(i.changedPaths);
  const evidence: CheckEvidence[] = [];
  const logs: string[] = [];
  const sha8 = i.headSha.slice(0, 8);
  const exists = (rel: string) => existsSync(join(i.worktree, rel));
  try {
    mkdirSync(i.logDir, { recursive: true });
  } catch {
    // the log is a convenience
  }

  interface Job {
    suite: IntegrationSuite;
    kind: 'check' | 'unit';
    argv: string[];
    timeoutMin: number;
  }
  const checkJobs: Job[] = [...i.suites]
    .map((suite, ix) => ({ suite, ix }))
    .sort((a, b) => checkOrder(a.suite) - checkOrder(b.suite) || a.ix - b.ix)
    .map(({ suite }) => ({ suite, kind: 'check' as const, argv: suite.cmd, timeoutMin: suite.timeoutMin }));
  const unitJobs: Job[] = [];
  for (const u of i.units ?? []) {
    if (!u.handoffCmd?.length) {
      evidence.push({
        name: u.name.slice(0, 60),
        command: cmdText(u.cmd),
        cwd: u.cwd,
        kind: 'unit',
        status: 'regression_only',
        exitCode: null,
        durationMs: 0,
        summary: 'not run at handoff: runs at regression',
        introduced: [],
        elsewhere: [],
        elsewhereCount: 0,
      });
      logs.push('');
    }
  }
  for (const r of handoffUnitRuns(i.units ?? [], i.changedPaths, exists))
    unitJobs.push({
      suite: r.suite,
      kind: 'unit',
      argv: r.argv,
      timeoutMin: r.suite.handoffTimeoutMin ?? UNIT_HANDOFF_TIMEOUT_MIN,
    });

  const runGroup = async (jobs: Job[], budget: number): Promise<void> => {
    const started = now();
    for (const job of jobs) {
      const { suite } = job;
      const base = {
        name: suite.name.slice(0, 60),
        command: cmdText(job.argv),
        cwd: suite.cwd,
        kind: job.kind,
        ...(suite.fix ? { fix: suite.fix.join(' ').slice(0, 500) } : {}),
      };
      const fail = (status: 'error' | 'timeout', summary: string, durationMs = 0): void => {
        evidence.push({
          ...base,
          status,
          exitCode: null,
          durationMs,
          summary,
          introduced: [],
          elsewhere: [],
          elsewhereCount: 0,
        });
        logs.push('');
      };
      if (!isSafeRelativeDir(suite.cwd)) {
        fail('error', 'the folder must stay inside the repository');
        continue;
      }
      const key = `${i.headSha}\0${job.kind}\0${suite.name}\0${job.argv.join(' ')}\0${suite.cwd}`;
      const hit = i.cache?.get(key);
      if (hit) {
        evidence.push(hit.evidence);
        logs.push(hit.log);
        continue;
      }
      const remaining = budget - (now() - started);
      if (remaining <= 1000) {
        fail('error', `not run: the ${Math.round(budget / 60_000)}-minute budget was used up`);
        continue;
      }
      if (!i.launch) {
        fail('error', 'this runner cannot run checks');
        continue;
      }
      let l: CheckLaunch;
      try {
        l = await i.launch(job.argv, `${job.kind === 'unit' ? 'u-' : ''}${sha8}`);
      } catch (err) {
        fail('error', (err instanceof Error ? err.message : String(err)).slice(0, 500));
        continue;
      }
      const t0 = now();
      const cwd = resolve(i.worktree, suite.cwd);
      const cap = await capture(l, cwd, Math.min(job.timeoutMin * 60_000, remaining), i.signal, spawnImpl);
      const durationMs = Math.max(0, now() - t0);
      const output = stripAnsi(cap.output);
      const logPath = join(i.logDir, `${job.kind === 'unit' ? 'unit-' : ''}${slug(suite.name)}-${sha8}.log`);
      let log = '';
      try {
        writeFileSync(logPath, cap.output);
        log = logPath;
      } catch {
        // not fatal
      }
      let ev: CheckEvidence;
      const budgetCut = cap.timedOut && remaining < job.timeoutMin * 60_000;
      const budgetText = `timed out: the ${budget >= 60_000 ? `${Math.round(budget / 60_000)}-minute` : `${Math.round(budget / 1000)}-second`} budget for these runs ran out`;
      if (job.kind === 'unit') {
        const failing = failingTestFiles(output);
        const v0 = judgeUnit(job.timeoutMin, cap, failing);
        const verdict = budgetCut ? { ...v0, summary: budgetText } : v0;
        const prefix = suite.cwd && suite.cwd !== '.' ? `${suite.cwd.replace(/\/+$/, '')}/` : '';
        const named = failing.map((f) => `FAIL ${prefix}${f}`);
        ev = {
          ...base,
          status: verdict.status,
          exitCode: cap.exitCode,
          durationMs,
          summary: verdict.summary.slice(0, 500),
          introduced: verdict.status === 'failed' ? named.slice(0, LIST_MAX) : [],
          ...(verdict.status === 'failed' ? { introducedCount: named.length } : {}),
          elsewhere: [],
          elsewhereCount: 0,
          ...(verdict.status === 'error' ||
          verdict.status === 'timeout' ||
          (verdict.status === 'failed' && !named.length)
            ? { tail: lastLines(cap.output) }
            : {}),
        };
      } else {
        const attributed = attribute(output, {
          cwd: suite.cwd,
          changed,
          exists,
          argv: job.argv,
          worktree: i.worktree,
          capped: cap.capped,
        });
        const v0 = judge(suite, cap, attributed);
        const verdict = budgetCut ? { ...v0, summary: budgetText } : v0;
        ev = {
          ...base,
          status: verdict.status,
          exitCode: cap.exitCode,
          durationMs,
          summary: verdict.summary.slice(0, 500),
          introduced: [],
          elsewhere: [],
          elsewhereCount: 0,
          ...(verdict.status === 'error' || verdict.status === 'timeout'
            ? { tail: lastLines(cap.output) }
            : {}),
        };
        if (verdict.status === 'failed') {
          const { own, owed, owedBy } = splitFindings(attributed, i.scope);
          const blockingFindings = i.scope?.defer ? own : attributed.findings;
          const inChanged = blockingFindings.filter((f) => f.changed).map((f) => f.line);
          const inOther = blockingFindings.filter((f) => !f.changed).map((f) => f.line);
          ev.introduced = inChanged.slice(0, LIST_MAX);
          ev.introducedCount = inChanged.length;
          ev.elsewhere = inOther.slice(0, LIST_MAX);
          ev.elsewhereCount = inOther.length;
          if (owed.length) {
            ev.owed = owed.map((f) => f.line).slice(0, LIST_MAX);
            ev.owedCount = owed.length;
            if (owedBy) ev.owedBy = owedBy;
          }
          if (i.scope?.defer && own.length === 0 && owed.length > 0) {
            ev.status = 'deferred';
            ev.summary = `${plural(owed.length, 'problem')} only in files the ${owedBy ?? 'tester'} owns: owed by the ${owedBy ?? 'tester'}, does not block this handoff`;
          }
        }
      }
      evidence.push(ev);
      logs.push(log);
      if (ev.status !== 'error' && ev.status !== 'timeout') i.cache?.set(key, { evidence: ev, log });
    }
  };

  await runGroup(checkJobs, i.budgetMs ?? CHECKS_BUDGET_MS);
  await runGroup(unitJobs, i.unitBudgetMs ?? UNIT_BUDGET_MS);

  const blockingIdx = evidence.flatMap((e, ix) => (checkStatusPasses(e.status) ? [] : [ix]));
  const blocking = blockingIdx.map((ix) => evidence[ix] as CheckEvidence);
  const refusal = blocking.length
    ? refusalText(
        blockingIdx.map((ix) => ({ ev: evidence[ix] as CheckEvidence, log: logs[ix] ?? '' })),
        i.scope,
      )
    : '';
  const bits = evidence.map((e) => {
    const n = e.kind === 'unit' ? `unit tests "${e.name}"` : e.name;
    return e.status === 'passed'
      ? `${n} passed`
      : e.status === 'deferred'
        ? `${n}: ${e.summary}`
        : e.status === 'regression_only'
          ? `${n} not run at handoff (runs at regression)`
          : `${n} ${e.status}`;
  });
  const summary = bits.length ? `Checks: ${bits.join('; ')}.` : '';
  return { evidence, blocking, refusal, summary };
}
