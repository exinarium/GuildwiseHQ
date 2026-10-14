import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IpcRpcResponse, ShiftEnvironment } from '@aom/shared';
import { attachFileFromAgent, type ServerHttp } from '../attachments/index.ts';
import type { RunManager } from '../runs/manager.ts';
import { redactValues } from '../runs/text.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import { redact } from '../secrets/redact.ts';
import { environmentNote } from './environment-note.ts';
import { findJunitFiles, type JunitCounts, readJunit } from './junit.ts';

/** The `source` a tester's suite log carries on the server (it lets the tester attach to its own card). */
const TEST_SUITE_SOURCE = 'test suite';
/** A log longer than this keeps its end (that is where the failure is). */
const MAX_LOG_BYTES = 1_000_000;

export interface TesterRpcCtx {
  /** The environment this shift was briefed with. */
  env: ShiftEnvironment | undefined;
  runs: RunManager | undefined;
  sandbox: Sandbox | undefined;
  /** The card worktree: reports and logs are looked for here (relative paths) and in the shift's temp dirs. */
  worktree: string | undefined;
  /** The commit under test, for the results table. */
  commit: () => string | undefined;
  rpc: (method: string, params: Record<string, unknown>) => Promise<IpcRpcResponse>;
  http: ServerHttp | undefined;
}

const text = (message: string): IpcRpcResponse => ({ ok: true, result: { message } });
const fail = (error: string): IpcRpcResponse => ({ ok: false, error });

/**
 * `aom env info|logs|restart|suites` and `aom test suite` of a tester (docs/design/run-and-integration-tests.md 4.4, 4.6).
 * The environment's facts come from the runner, the suites and results from the server.
 */
export async function testerRpc(
  ctx: TesterRpcCtx,
  method: string,
  params: Record<string, unknown>,
): Promise<IpcRpcResponse> {
  const envId = ctx.env?.envId;
  switch (method) {
    case 'env.info': {
      if (!ctx.env) return text("This shift has no environment: follow the card's test plan.");
      const view = envId ? ctx.runs?.testEnvironment(envId) : null;
      return text(environmentNote(ctx.env, view));
    }
    case 'env.logs':
    case 'env.restart': {
      if (ctx.env?.mode !== 'local' || !envId || !ctx.runs)
        return fail('this shift has no local environment on this workstation');
      return ctx.runs.testerRpc(envId, method, params);
    }
    case 'env.suites':
    case 'env.suites.propose':
      return ctx.rpc(method, params);
    case 'test.suite':
      return suiteReport(ctx, params);
    default:
      return fail(`${method} is not available`);
  }
}

/** The folders a tester's files may be read from: its worktree, scratch and temp dirs. */
function roots(ctx: TesterRpcCtx): string[] {
  return [ctx.worktree, ctx.sandbox?.scratch, ctx.sandbox?.tmp].filter((x): x is string => !!x);
}

/** Turns a path the tester gave (absolute inside a root, or relative to the worktree) into root + relative path. */
function locate(ctx: TesterRpcCtx, path: string): { root: string; rel: string } | null {
  const rs = roots(ctx);
  if (isAbsolute(path)) {
    for (const root of rs) {
      const rel = relative(root, resolve(path));
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return { root, rel: rel.split(sep).join('/') };
    }
    return null;
  }
  const root = ctx.worktree ?? rs[0];
  return root ? { root, rel: path } : null;
}

function safeFileName(s: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'suite'
  );
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;

/**
 * `aom test suite`: counts come from the JUnit report when there is one (a report with failing cases cannot be recorded as
 * passed), the log or report is attached to the card with known secret values removed, and the result goes to the server.
 */
async function suiteReport(ctx: TesterRpcCtx, p: Record<string, unknown>): Promise<IpcRpcResponse> {
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  let status = typeof p.status === 'string' ? p.status : '';
  if (!name)
    return fail(
      'usage: aom test suite --name <suite> --status passed|failed|timeout|skipped [--junit <glob>] [--log <file>]',
    );
  if (!['passed', 'failed', 'timeout', 'skipped', 'flaky'].includes(status))
    return fail('--status must be passed, failed, timeout or skipped');

  let counts: Pick<JunitCounts, 'passed' | 'failed' | 'skipped' | 'seconds' | 'failures'> = {
    passed: num(p.passed) ?? 0,
    failed: num(p.failed) ?? 0,
    skipped: num(p.skipped) ?? 0,
    seconds: (num(p.durationMs) ?? 0) / 1000,
    failures: [],
  };
  let reportFile: string | undefined;
  let note = '';
  const junit = typeof p.junit === 'string' && p.junit.trim() ? p.junit.trim() : undefined;
  if (junit) {
    const at = locate(ctx, junit);
    if (!at) return fail('the report must be inside your worktree, scratch or temp folder');
    try {
      const c = readJunit(at.root, at.rel);
      counts = { ...c, seconds: c.seconds || counts.seconds };
      reportFile = findJunitFiles(at.root, at.rel)[0];
      if (c.failed > 0 && (status === 'passed' || status === 'flaky')) {
        status = 'failed';
        note = `The report has ${c.failed} failing case${c.failed === 1 ? '' : 's'}, so this is recorded as failed.`;
      } else if (c.failed === 0 && c.passed + c.skipped === 0 && status === 'passed') {
        status = 'failed';
        note = 'The report holds no test cases, so this is recorded as failed.';
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  // The log (or, without one, the report) goes on the card, redacted.
  let attachmentName: string | undefined;
  const logArg = typeof p.log === 'string' && p.log.trim() ? p.log.trim() : undefined;
  const source = logArg ? locate(ctx, logArg) : null;
  if (logArg && !source) return fail('the log must be inside your worktree, scratch or temp folder');
  const file = source ? join(source.root, source.rel) : reportFile;
  if (file && ctx.sandbox && ctx.http) {
    try {
      const real = realpathSync(file);
      if (!roots(ctx).some((r) => real === realpathSync(r) || real.startsWith(realpathSync(r) + sep)))
        return fail('the file must be inside your worktree, scratch or temp folder');
      const size = statSync(real).size;
      let body = readFileSync(real, 'utf8');
      if (size > MAX_LOG_BYTES) body = `[the start of the file was left out]\n${body.slice(-MAX_LOG_BYTES)}`;
      body = redact(
        redactValues(body, ctx.runs && ctx.env?.envId ? ctx.runs.secretsOf(ctx.env.envId) : new Set()),
      );
      const dir = join(ctx.sandbox.tmp, 'suite-logs');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const ext = /\.xml$/i.test(real) ? 'xml' : 'log';
      attachmentName = `${safeFileName(name)}-${Date.now().toString(36)}.${ext}`;
      const out = join(dir, attachmentName);
      writeFileSync(out, body || '(empty)', { mode: 0o600 });
      await attachFileFromAgent({
        path: out,
        roots: [dir],
        source: TEST_SUITE_SOURCE,
        rpc: ctx.rpc,
        http: ctx.http,
      });
    } catch (err) {
      note =
        `${note} The log could not be attached: ${err instanceof Error ? err.message : String(err)}`.trim();
      attachmentName = undefined;
    }
  }

  const r = await ctx.rpc('test.suite', {
    name,
    status,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    durationMs: Math.round(counts.seconds * 1000),
    failures: counts.failures,
    ...(ctx.commit() ? { commit: ctx.commit() } : {}),
    ...(attachmentName ? { attachmentName } : {}),
    ...(note ? { note: note.slice(0, 2000) } : {}),
  });
  if (!r.ok) return r;
  const res = r.result as { message?: string } | undefined;
  return text(`${note ? `${note} ` : ''}${res?.message ?? 'Recorded.'}`);
}
