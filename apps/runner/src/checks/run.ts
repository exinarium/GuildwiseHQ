import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHECKS_BUDGET_MS, type CheckEvidence, type IntegrationSuite, isSafeRelativeDir } from '@aom/shared';
import { type Attribution, attribute, stripAnsi } from './attribute.ts';

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

export interface RunChecksInput {
  suites: readonly IntegrationSuite[];
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
  /** Results by head and check, so a second `aom handoff` at the same head does not run them again (never `error`/`timeout`). */
  cache?: Map<string, { evidence: CheckEvidence; log: string }>;
}

export interface RunChecksResult {
  evidence: CheckEvidence[];
  /** The checks that found problems in files the card changed. */
  blocking: CheckEvidence[];
  /** The text that refuses the handoff (empty when nothing blocks). */
  refusal: string;
  /** One line for the accepted handoff: what ran and what could not. */
  summary: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'check';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

interface Captured {
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

function capture(
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

function judge(
  suite: IntegrationSuite,
  c: Captured,
  a: Attribution,
): Pick<CheckEvidence, 'status' | 'summary'> {
  if (c.aborted) return { status: 'error', summary: 'stopped: the shift ended while the check was running' };
  if (c.spawnError !== undefined) {
    return /ENOENT/.test(c.spawnError)
      ? { status: 'error', summary: `missing tool: ${c.spawnError}`.slice(0, 500) }
      : { status: 'error', summary: `could not start: ${c.spawnError}`.slice(0, 500) };
  }
  if (c.timedOut)
    return { status: 'timeout', summary: `timed out after ${plural(suite.timeoutMin, 'minute')}` };
  if (c.exitCode === 0) return { status: 'passed', summary: 'passed' };
  if (c.exitCode === 126 || c.exitCode === 127 || (a.introducedCount === 0 && MISSING_TOOL.test(c.output)))
    return { status: 'error', summary: 'missing tool or script: the command could not run here' };
  if (a.introducedCount > 0)
    return {
      status: 'failed',
      summary: `${plural(a.introducedCount, 'problem')} in files this card changed${
        a.elsewhereCount ? `, ${plural(a.elsewhereCount, 'more')} in other files (not blocking)` : ''
      }`,
    };
  if (a.incomplete)
    return { status: 'error', summary: `the output is incomplete, so it cannot be judged: ${a.incomplete}` };
  if (a.elsewhereCount > 0)
    return {
      status: 'preexisting',
      summary: `${plural(a.elsewhereCount, 'problem')} only in files this card did not change`,
    };
  return { status: 'error', summary: `failed (exit ${c.exitCode ?? '?'}) without naming a file` };
}

const cmdText = (s: IntegrationSuite): string => s.cmd.join(' ').slice(0, 500);

function refusalText(blocking: Array<{ ev: CheckEvidence; log: string }>, others: CheckEvidence[]): string {
  const parts: string[] = [];
  for (const { ev, log } of blocking) {
    const lines = [
      `the check "${ev.name}" (\`${ev.command}\`) fails: ${ev.summary}:`,
      ...ev.introduced.map((l) => `  ${l}`),
      ev.fix
        ? `Fix: \`${ev.fix}\` may repair this: run it, review the diff, commit, then run \`aom handoff\` again.`
        : 'Fix the problems above, commit, then run `aom handoff` again.',
      ...(log ? [`Full output: ${log}`] : []),
    ];
    const elsewhere = ev.elsewhereCount;
    if (elsewhere > 0)
      lines.push(`Not blocking: ${plural(elsewhere, 'problem')} in files this card did not change.`);
    parts.push(lines.join('\n'));
  }
  const unjudged = others.filter((e) => e.status === 'error' || e.status === 'timeout');
  if (unjudged.length)
    parts.push(
      `Not judged (does not block): ${unjudged.map((e) => `"${e.name}": ${e.summary}`).join('; ')}.`,
    );
  parts.push('Nothing was handed to review.');
  const text = parts.join('\n\n');
  return text.length <= REFUSAL_MAX
    ? text
    : `${text.slice(0, REFUSAL_MAX - 40)}\n[cut]\nNothing was handed to review.`;
}

/**
 * Runs the confirmed checks of the card's repository on the committed tree (the worktree, after the autocommit), one after
 * the other under a shared budget. A failure in a changed file blocks; everything that cannot be judged is a recorded
 * warning, never a silent pass.
 */
export async function runHandoffChecks(i: RunChecksInput): Promise<RunChecksResult> {
  const now = i.now ?? Date.now;
  const spawnImpl = i.spawnImpl ?? nodeSpawn;
  const started = now();
  const budget = i.budgetMs ?? CHECKS_BUDGET_MS;
  const changed = new Set(i.changedPaths);
  const evidence: CheckEvidence[] = [];
  const logs: string[] = [];
  const sha8 = i.headSha.slice(0, 8);
  try {
    mkdirSync(i.logDir, { recursive: true });
  } catch {
    // the log is a convenience
  }

  for (const suite of i.suites) {
    const base = {
      name: suite.name.slice(0, 60),
      command: cmdText(suite),
      cwd: suite.cwd,
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
    const key = `${i.headSha}\0${suite.name}\0${suite.cmd.join(' ')}\0${suite.cwd}`;
    const hit = i.cache?.get(key);
    if (hit) {
      evidence.push(hit.evidence);
      logs.push(hit.log);
      continue;
    }
    const remaining = budget - (now() - started);
    if (remaining <= 1000) {
      fail('error', `not run: the ${Math.round(budget / 60_000)}-minute budget for checks was used up`);
      continue;
    }
    if (!i.launch) {
      fail('error', 'this runner cannot run checks');
      continue;
    }
    let l: CheckLaunch;
    try {
      l = await i.launch(suite.cmd, sha8);
    } catch (err) {
      fail('error', (err instanceof Error ? err.message : String(err)).slice(0, 500));
      continue;
    }
    const t0 = now();
    const cwd = resolve(i.worktree, suite.cwd);
    const cap = await capture(l, cwd, Math.min(suite.timeoutMin * 60_000, remaining), i.signal, spawnImpl);
    const durationMs = Math.max(0, now() - t0);
    const output = stripAnsi(cap.output);
    const attributed = attribute(output, {
      cwd: suite.cwd,
      changed,
      exists: (rel) => existsSync(join(i.worktree, rel)),
      argv: suite.cmd,
      worktree: i.worktree,
      capped: cap.capped,
    });
    const verdict = judge(suite, cap, attributed);
    const logPath = join(i.logDir, `${slug(suite.name)}-${sha8}.log`);
    let log = '';
    try {
      writeFileSync(logPath, cap.output);
      log = logPath;
    } catch {
      // not fatal
    }
    const ev: CheckEvidence = {
      ...base,
      status: verdict.status,
      exitCode: cap.exitCode,
      durationMs,
      summary: verdict.summary.slice(0, 500),
      introduced: verdict.status === 'failed' ? attributed.introduced : [],
      elsewhere: attributed.elsewhere,
      elsewhereCount: attributed.elsewhereCount,
    };
    evidence.push(ev);
    logs.push(log);
    if (ev.status !== 'error' && ev.status !== 'timeout') i.cache?.set(key, { evidence: ev, log });
  }

  const blockingIdx = evidence.flatMap((e, ix) => (e.status === 'failed' ? [ix] : []));
  const blocking = blockingIdx.map((ix) => evidence[ix] as CheckEvidence);
  const refusal = blocking.length
    ? refusalText(
        blockingIdx.map((ix) => ({ ev: evidence[ix] as CheckEvidence, log: logs[ix] ?? '' })),
        evidence.filter((e) => e.status !== 'failed'),
      )
    : '';
  const bits = evidence.map((e) =>
    e.status === 'passed'
      ? `${e.name} passed`
      : e.status === 'preexisting'
        ? `${e.name} passed (${plural(e.elsewhereCount, 'problem')} only in files this card did not change)`
        : e.status === 'failed'
          ? `${e.name} failed`
          : `${e.name} could not be judged (${e.summary})`,
  );
  const summary = bits.length ? `Checks: ${bits.join('; ')}.` : '';
  return { evidence, blocking, refusal, summary };
}
