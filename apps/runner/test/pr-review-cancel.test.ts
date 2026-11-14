import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PrReviewRunPayload } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatStartInput, RuntimeAdapter, RuntimeEvent, RuntimeSession } from '../src/adapters/types.ts';
import { runnerPaths } from '../src/paths.ts';
import { PrReviewCommands } from '../src/review/pr-review-commands.ts';
import type { ReviewerRun } from '../src/review/reviewer-sandbox.ts';
import { runPrReview } from '../src/review/run.ts';
import { cleanupTmp, tmp } from './helpers.ts';

/**
 * GWP-204: the server cancels the partner run of a review round when the other run timed out or failed. Fake adapter;
 * no model and no git host.
 */

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const payload = (runId: string): PrReviewRunPayload => ({
  runId,
  projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
  prReviewId: '019e3f6a-7b1c-7a2d-8c3e-0123456789e5',
  projectRepoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
  remoteUrlNormalized: 'github.com/acme/toy',
  prNumber: 7,
  baseRef: 'main',
  title: 'Add the thing',
  reviewer: 'second',
  runtime: 'claude-code',
  model: 'opus',
  timeoutMs: 60_000,
});
const RUN_A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const RUN_B = '019e3f6a-7b1c-7a2d-8c3e-0123456789a2';

/** A session that never answers until it is stopped. */
function hangingSession(stops: string[]): RuntimeSession {
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((r) => {
    stop = r;
  });
  return {
    async *events() {
      await stopped;
      yield { kind: 'exit', code: 143 } as RuntimeEvent;
    },
    async stop(reason: string) {
      stops.push(reason);
      stop();
    },
    usage: () => undefined,
  } as unknown as RuntimeSession;
}

function fixture() {
  const base = tmp();
  const paths = runnerPaths(join(base, 'runner'));
  const stops: string[] = [];
  const starts: ChatStartInput[] = [];
  const disposed: ReviewerRun[] = [];
  const adapter = {
    runtime: 'claude-code',
    instructionStyle: 'cli',
    writeInstructions: async () => undefined,
    startChat: async (input: ChatStartInput) => {
      starts.push(input);
      return hangingSession(stops);
    },
  } as unknown as RuntimeAdapter;
  const deps = {
    adapter,
    paths,
    graceMs: 30,
    heads: async () => ({ headSha: HEAD, baseSha: BASE }),
    prepare: async (spec: { runId: string }) => {
      const runDir = join(base, 'reviews', spec.runId);
      const checkout = join(runDir, 'checkout');
      mkdirSync(checkout, { recursive: true });
      mkdirSync(join(runDir, 'scratch'), { recursive: true });
      return {
        spec,
        runDir,
        checkout,
        sandbox: {
          agentId: `pr-review-${spec.runId}`,
          root: runDir,
          home: join(runDir, 'home'),
          configDir: join(runDir, 'claude'),
          scratch: join(runDir, 'scratch'),
          tmp: join(base, 'tmp', spec.runId),
        },
      } as unknown as ReviewerRun;
    },
    dispose: async (run: ReviewerRun) => {
      disposed.push(run);
    },
    diff: async () => 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n x\n+y\n',
    numstat: async () => '1\t0\ta\n',
  } as Parameters<typeof runPrReview>[0];
  return { deps, stops, starts, disposed };
}
afterEach(() => cleanupTmp());

describe('runPrReview with an abort signal', () => {
  it('stops the live session, answers failed/cancelled (not retryable) and cleans up', async () => {
    const fx = fixture();
    const abort = new AbortController();
    const running = runPrReview({ ...fx.deps, signal: abort.signal }, payload(RUN_A));
    while (fx.starts.length === 0) await new Promise((r) => setTimeout(r, 5)); // the model session is running
    abort.abort();
    const result = await running;
    expect(result).toMatchObject({ outcome: 'failed', code: 'cancelled', retryable: false });
    expect(fx.stops).toEqual(['pr_review.cancel']);
    expect(fx.disposed).toHaveLength(1);
  });

  it('a signal that is already aborted answers cancelled without a model session', async () => {
    const fx = fixture();
    const abort = new AbortController();
    abort.abort();
    const result = await runPrReview({ ...fx.deps, signal: abort.signal }, payload(RUN_A));
    expect(result).toMatchObject({ outcome: 'failed', code: 'cancelled' });
    expect(fx.starts).toHaveLength(0);
  });
});

describe('PrReviewCommands.cancel', () => {
  it('a cancel for a run that has not arrived is remembered: the run then answers cancelled at once, with no session', async () => {
    const commands = new PrReviewCommands({} as never); // never reaches the environment: it answers before starting
    expect(commands.cancel({ runId: RUN_B, reason: 'partner_timeout' })).toEqual({ found: false });
    const answer = await commands.run(payload(RUN_B));
    expect(answer).toMatchObject({ outcome: 'failed', code: 'cancelled', retryable: false });
  });

  it('a cancel for an unknown run is harmless and a run that was not cancelled is not affected', () => {
    const commands = new PrReviewCommands({} as never);
    expect(commands.cancel({ runId: RUN_A, reason: 'partner_failed' })).toEqual({ found: false });
    expect(commands.liveRunIds()).toEqual([]);
  });
});
