import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PrReviewRunPayload } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatStartInput, RuntimeAdapter, RuntimeEvent, RuntimeSession } from '../src/adapters/types.ts';
import { runnerPaths } from '../src/paths.ts';
import type { ReviewerRun } from '../src/review/reviewer-sandbox.ts';
import { parseReviewerOutput, runPrReview } from '../src/review/run.ts';
import { cleanupTmp, tmp } from './helpers.ts';

afterEach(() => cleanupTmp());

const RUN = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const payload: PrReviewRunPayload = {
  runId: RUN,
  projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
  prReviewId: '019e3f6a-7b1c-7a2d-8c3e-0123456789e5',
  projectRepoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
  remoteUrlNormalized: 'github.com/acme/toy',
  prNumber: 7,
  baseRef: 'main',
  title: 'Add the thing',
  reviewer: 'first',
  runtime: 'claude-code',
  model: 'sonnet',
  timeoutMs: 5000,
};
const finding = (severity: unknown, n = 1) => ({
  path: `a${n}.ts`,
  line: null,
  severity,
  title: 't',
  body: 'b',
});
const block = (findings: unknown[]) => `===REVIEW-JSON===\n${JSON.stringify({ summary: 's', findings })}`;

function deps(numstat: () => Promise<string>) {
  const base = tmp();
  const adapter = {
    runtime: 'claude-code',
    instructionStyle: 'cli',
    writeInstructions: async () => undefined,
    accountGate: () => ({ state: 'ok' }),
    startChat: async (_i: ChatStartInput) =>
      ({
        async *events() {
          yield { kind: 'final', text: block([finding('high')]) } as RuntimeEvent;
          yield { kind: 'exit', code: 0 } as RuntimeEvent;
        },
        stop: async () => undefined,
        usage: () => undefined,
      }) as unknown as RuntimeSession,
  } as unknown as RuntimeAdapter;
  return {
    adapter,
    paths: runnerPaths(join(base, 'runner')),
    graceMs: 30,
    heads: async () => ({ headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }),
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
    dispose: async () => undefined,
    diff: async () => '',
    numstat,
  } as Parameters<typeof runPrReview>[0];
}

describe('changed lines in the completed result', () => {
  it('sends added + removed lines from the numstat', async () => {
    const out = await runPrReview(
      deps(async () => '200\t50\ta.ts\n-\t-\tb.png\n'),
      payload,
    );
    expect(out).toMatchObject({ outcome: 'completed', changedLines: 250 });
  });
  it('a failed count leaves changedLines out and the run still completes', async () => {
    const out = await runPrReview(
      deps(async () => {
        throw new Error('boom');
      }),
      payload,
    );
    expect(out.outcome).toBe('completed');
    expect('changedLines' in out).toBe(false);
  });
});

describe('parseReviewerOutput keeps the findings', () => {
  it('an unknown or missing severity becomes low', () => {
    const out = parseReviewerOutput(block([finding('nit'), finding(undefined, 2), finding('critical', 3)]));
    expect(out?.findings.map((f) => f.severity)).toEqual(['low', 'low', 'high']);
  });
  it('more than 50 findings keep the first 50', () => {
    const many = Array.from({ length: 55 }, (_, i) => finding('low', i));
    const lines: string[] = [];
    const out = parseReviewerOutput(block(many), (l) => lines.push(l));
    expect(out?.findings).toHaveLength(50);
    expect(lines.join('\n')).toMatch(/5 findings past the first 50/);
  });
});
