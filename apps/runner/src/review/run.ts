import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  changedLinesFromNumstat,
  normaliseSeverity,
  type PrReviewFailureCode,
  type PrReviewFinding,
  type PrReviewRunPayload,
  type PrReviewRunResult,
  ReviewerOutputSchema,
  ReviewerRunSpecSchema,
  type Usage,
} from '@aom/shared';
import type { RuntimeAdapter, RuntimeSession } from '../adapters/types.ts';
import { readSession } from '../delegate/delegate.ts';
import { git } from '../git/git.ts';
import type { RunnerPaths } from '../paths.ts';
import { cleanAgentTmp, sandboxEnv, sandboxFor, wipeAgent } from '../sandbox/sandbox.ts';
import { REVIEW_JSON_MARKER, renderReviewerInstructions, renderReviewerPrompt } from './instructions.ts';
import { ReviewCheckoutError, ReviewHeadMovedError } from './review-checkout.ts';
import { type ReviewerRefusal, type ReviewerRun, reviewerPermissions } from './reviewer-sandbox.ts';

export interface PrReviewRunDeps {
  adapter: RuntimeAdapter;
  paths: RunnerPaths;
  /** The head and base commit of the pull request right now (production: `Forge.changeHeads`). */
  heads: (payload: PrReviewRunPayload) => Promise<{ headSha: string; baseSha: string }>;
  /** Production: `prepareReviewerRun`. `configDir` is the run's own Claude config dir. */
  prepare: (
    spec: ReturnType<typeof ReviewerRunSpecSchema.parse>,
    ctx: { agentId: string; configDir: string },
  ) => Promise<ReviewerRun | { refused: ReviewerRefusal }>;
  /** Production: `disposeReviewerRun`. */
  dispose: (run: ReviewerRun) => Promise<void>;
  /** `git diff` of the checkout between the base and the head; production runs git in the checkout. */
  diff?: (run: ReviewerRun) => Promise<string>;
  /** `git diff --numstat` of the same range; production runs git in the checkout. Used for the findings cap. */
  numstat?: (run: ReviewerRun) => Promise<string>;
  now?: () => number;
  log?: (line: string) => void;
  /** How long a timed-out run waits for its own cleanup before it answers anyway (default 3 s). */
  graceMs?: number;
}

/** Added and context lines of the new file, per path: the lines a review comment can be attached to. */
export function anchoredLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: Set<number> | undefined;
  let next = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p === '/dev/null') {
        file = undefined;
      } else {
        const path = p.startsWith('b/') ? p.slice(2) : p;
        file = out.get(path) ?? new Set<number>();
        out.set(path, file);
      }
      next = 0;
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      next = Number(h[1]);
      continue;
    }
    if (!file || next === 0) continue;
    if (line.startsWith('+')) file.add(next++);
    else if (line.startsWith(' ')) file.add(next++);
    // a removed line ('-') and "\ No newline" have no line in the new file
  }
  return out;
}

/** The last `===REVIEW-JSON===` block of the reviewer's final text, validated; null when there is none or it is not valid. */
export function parseReviewerOutput(
  text: string,
  log?: (line: string) => void,
): ReturnType<typeof ReviewerOutputSchema.parse> | null {
  const at = text.lastIndexOf(REVIEW_JSON_MARKER);
  if (at < 0) return null;
  const rest = text.slice(at + REVIEW_JSON_MARKER.length);
  const from = rest.indexOf('{');
  const to = rest.lastIndexOf('}');
  if (from < 0 || to <= from) return null;
  try {
    const raw: unknown = JSON.parse(rest.slice(from, to + 1));
    const parsed = ReviewerOutputSchema.safeParse(prepareOutput(raw, log));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Unknown or missing severities become `low` and more than 50 findings are cut to the first 50, instead of losing the review. */
function prepareOutput(raw: unknown, log?: (line: string) => void): unknown {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { findings?: unknown }).findings)) return raw;
  const o = raw as { findings: unknown[] };
  let coerced = 0;
  const findings = o.findings.map((f) => {
    if (!f || typeof f !== 'object') return f;
    const sev = (f as { severity?: unknown }).severity;
    const next = normaliseSeverity(sev);
    if (sev !== next) coerced++;
    return { ...f, severity: next };
  });
  if (coerced > 0)
    log?.(`pr review: ${coerced} finding severities were not high/medium/low and were normalised`);
  if (findings.length > 50) log?.(`pr review: ${findings.length - 50} findings past the first 50 were cut`);
  return { ...o, findings: findings.slice(0, 50) };
}

const fail = (
  durationMs: number,
  code: PrReviewFailureCode,
  error: string,
  retryable: boolean,
): PrReviewRunResult => ({ outcome: 'failed', durationMs, code, error: error.slice(0, 400), retryable });

const REFUSAL: Record<ReviewerRefusal, { code: PrReviewFailureCode; retryable: boolean; error: string }> = {
  reviewer_token_missing: {
    code: 'no_token',
    retryable: false,
    error: 'no reviewer token is saved for this repository on this workstation',
  },
  unsupported_host: { code: 'unsupported', retryable: false, error: 'reviews are only supported on GitHub' },
  sandbox_unavailable: {
    code: 'runtime_unavailable',
    retryable: true,
    error: 'the sandbox is not enforced on this workstation, so no review can run',
  },
  no_clone: {
    code: 'no_checkout',
    retryable: true,
    error: 'this workstation has no clone of the repository',
  },
};

/**
 * One reviewer run: looks up the pull request's commits, builds the read-only checkout, lets the model read the change
 * and parses its findings. It NEVER posts anything: a completed run hands its findings back, and only the server can
 * start the post. The timer covers the whole run (also a checkout that hangs); a run that hits it answers `timeout`
 * and its model session is stopped, so nothing it was still writing can reach the pull request.
 */
export async function runPrReview(
  deps: PrReviewRunDeps,
  payload: PrReviewRunPayload,
): Promise<PrReviewRunResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const elapsed = () => Math.max(0, now() - t0);
  const agentId = `pr-review-${payload.runId}`;
  let phase: 'checkout' | 'review' = 'checkout';
  let timedOut = false;
  let session: RuntimeSession | undefined;
  let run: ReviewerRun | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const work = async (): Promise<PrReviewRunResult> => {
    // 1. the commits, right before the checkout
    let heads: { headSha: string; baseSha: string };
    try {
      heads = await deps.heads(payload);
    } catch (err) {
      return fail(elapsed(), 'no_checkout', `could not read the pull request: ${msg(err)}`, true);
    }
    const spec = ReviewerRunSpecSchema.safeParse({
      runId: payload.runId,
      projectId: payload.projectId,
      projectRepoId: payload.projectRepoId,
      remoteUrlNormalized: payload.remoteUrlNormalized,
      prNumber: payload.prNumber,
      headSha: heads.headSha,
      baseSha: heads.baseSha,
      baseRef: payload.baseRef,
    });
    if (!spec.success) return fail(elapsed(), 'no_checkout', 'the pull request commits are not valid', true);
    if (timedOut) return fail(elapsed(), 'error', 'stopped', false);

    // 2. the read-only checkout (cannot be cancelled: a timeout waits for it to settle and disposes it)
    const configDir = sandboxFor(deps.paths, agentId).configDir;
    let prepared: Awaited<ReturnType<PrReviewRunDeps['prepare']>>;
    try {
      prepared = await deps.prepare(spec.data, { agentId, configDir });
    } catch (err) {
      if (err instanceof ReviewHeadMovedError)
        return fail(elapsed(), 'head_moved', 'the pull request changed while the review was starting', true);
      if (err instanceof ReviewCheckoutError)
        return fail(elapsed(), 'no_checkout', `the checkout failed: ${msg(err)}`, true);
      return fail(elapsed(), 'no_checkout', `the checkout failed: ${msg(err)}`, true);
    }
    if ('refused' in prepared) {
      const r = REFUSAL[prepared.refused];
      return fail(elapsed(), r.code, r.error, r.retryable);
    }
    run = prepared;
    if (timedOut) return fail(elapsed(), 'error', 'stopped', false);

    // 3. the change, written by the runner (the checkout is read-only; the agent reads the file)
    let diffText: string;
    try {
      diffText = await (deps.diff ?? gitDiff)(run);
    } catch (err) {
      return fail(elapsed(), 'no_checkout', `could not read the change: ${msg(err)}`, true);
    }
    let changedLines: number | undefined;
    try {
      changedLines = changedLinesFromNumstat(await (deps.numstat ?? gitNumstat)(run));
    } catch (err) {
      deps.log?.(`pr review ${payload.runId}: could not count the changed lines: ${msg(err)}`);
    }
    const anchors = anchoredLines(diffText);
    const diffPath = join(run.sandbox.scratch, 'pr.diff');
    await mkdir(run.sandbox.scratch, { recursive: true });
    await writeFile(diffPath, diffText);

    // 4. the model
    const gate = deps.adapter.accountGate?.('main');
    if (gate && gate.state !== 'ok')
      return fail(
        elapsed(),
        'runtime_unavailable',
        `the ${payload.runtime} account is not available (${gate.state})`,
        true,
      );
    if (!deps.adapter.startChat)
      return fail(elapsed(), 'runtime_unavailable', `${payload.runtime} cannot run a review`, false);
    await mkdir(run.sandbox.configDir, { recursive: true });
    if (deps.adapter.instructionStyle !== 'tools')
      await deps.adapter.writeInstructions(run.sandbox, renderReviewerInstructions());
    phase = 'review';
    const logFile = join(deps.paths.shiftLogs, `pr-review-${payload.runId}.jsonl`);
    session = await deps.adapter.startChat({
      chatId: payload.runId,
      message: renderReviewerPrompt({ diffPath, title: payload.title, changedFiles: anchors.size }),
      cwd: run.checkout,
      sandbox: run.sandbox,
      // the sandbox's own variables only: no IPC url, no shift token, no git host token
      env: sandboxEnv(run.sandbox),
      readOnly: true,
      readDirs: [],
      agent: {
        agentId,
        name: 'Reviewer',
        roleKey: 'reviewer',
        seniority: 'senior',
        runtime: payload.runtime,
        model: payload.model,
        skills: [],
        permissions: reviewerPermissions(),
        isDevops: false,
      },
      reviewRun: run,
      ...(deps.adapter.instructionStyle === 'tools' ? { instructions: renderReviewerInstructions() } : {}),
      logFile,
    });
    if (timedOut) void session.stop('pr_review.timeout');
    const read = await readSession(session, undefined, () => undefined);
    const usage: Usage | undefined = safeUsage(session);
    if (timedOut) return { outcome: 'timeout', durationMs: elapsed(), phase };
    if (read.exit.authFailed)
      return fail(elapsed(), 'runtime_unavailable', 'the Claude login on this workstation has expired', true);
    if (read.exit.usageLimit)
      return fail(
        elapsed(),
        'runtime_unavailable',
        'the Claude usage limit on this workstation has been reached',
        true,
      );
    if (read.exit.code !== 0)
      return fail(
        elapsed(),
        'model_error',
        read.exit.error ?? `the ${payload.runtime} process exited with code ${read.exit.code}`,
        true,
      );
    const out = parseReviewerOutput(read.text, deps.log);
    if (!out)
      return fail(elapsed(), 'bad_output', 'the reviewer did not answer in the expected format', true);
    const findings: PrReviewFinding[] = out.findings.map((f) => ({
      ...f,
      anchored: f.line !== null && (anchors.get(f.path)?.has(f.line) ?? false),
    }));
    return {
      outcome: 'completed',
      headSha: run.spec.headSha,
      baseSha: run.spec.baseSha,
      durationMs: elapsed(),
      summary: out.summary,
      findings,
      ...(changedLines !== undefined ? { changedLines } : {}),
      ...(usage ? { usage } : {}),
    };
  };

  const cleanup = async (): Promise<void> => {
    if (run) await deps.dispose(run).catch(() => undefined);
    await cleanAgentTmp(sandboxFor(deps.paths, agentId).tmp).catch(() => 0);
    await wipeAgent(deps.paths, agentId).catch(() => undefined);
  };

  // `work` always cleans up after itself, whenever it settles (a checkout that hangs is disposed when it comes back)
  const settled = work()
    .catch((err): PrReviewRunResult => fail(elapsed(), 'error', msg(err), false))
    .finally(cleanup);
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      void session?.stop('pr_review.timeout').catch(() => undefined);
      resolve('timeout');
    }, payload.timeoutMs);
    timer.unref?.();
  });
  try {
    const first = await Promise.race([settled, timeout]);
    if (first !== 'timeout') return first;
    deps.log?.(`pr review ${payload.runId} hit its time limit in the ${phase} phase`);
    // give the stopped session and the checkout a moment to clean up; the answer is `timeout` whatever they do
    await Promise.race([
      settled.then(() => undefined),
      new Promise<void>((r) => {
        const g = setTimeout(r, deps.graceMs ?? 3000);
        g.unref?.();
      }),
    ]);
    return { outcome: 'timeout', durationMs: elapsed(), phase };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

function safeUsage(session: RuntimeSession): Usage | undefined {
  try {
    return session.usage();
  } catch {
    return undefined;
  }
}

/** The change between the base and the head of the checkout (read-only: `git diff` between commits writes nothing). */
async function gitDiff(run: ReviewerRun): Promise<string> {
  const r = await git(run.checkout, ['diff', '--no-color', '--unified=3', 'refs/review/base...HEAD']);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim().slice(0, 200) || 'git diff failed');
  return r.stdout;
}

/** Added and removed lines per file, between the same base and head as the diff. */
async function gitNumstat(run: ReviewerRun): Promise<string> {
  const r = await git(run.checkout, ['diff', '--numstat', 'refs/review/base...HEAD']);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim().slice(0, 200) || 'git diff --numstat failed');
  return r.stdout;
}
