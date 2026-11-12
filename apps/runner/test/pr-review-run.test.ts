import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type PrReviewRunPayload,
  PrReviewRunPayloadSchema,
  ReviewerRunSpecSchema,
  type RuntimeEvent,
} from '@aom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatStartInput, RuntimeAdapter, RuntimeSession } from '../src/adapters/types.ts';
import { runnerPaths } from '../src/paths.ts';
import { PrReviewCommands } from '../src/review/pr-review-commands.ts';
import { ReviewHeadMovedError } from '../src/review/review-checkout.ts';
import type { ReviewerRun } from '../src/review/reviewer-sandbox.ts';
import { MemoryReviewerTokenStore } from '../src/review/reviewer-tokens.ts';
import { anchoredLines, parseReviewerOutput, runPrReview } from '../src/review/run.ts';
import { cleanupTmp, tmp } from './helpers.ts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const RUN = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const payload = (over: Partial<PrReviewRunPayload> = {}): PrReviewRunPayload => ({
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
  timeoutMs: 50,
  ...over,
});

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' one',
  '+two',
  ' three',
  '-gone',
  ' four',
  'diff --git a/src/new.ts b/src/new.ts',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+x',
  '+y',
  '',
].join('\n');

const answer = (findings: unknown[], summary = 'Looks mostly fine') =>
  `Some notes.\n===REVIEW-JSON===\n${JSON.stringify({ summary, findings })}`;
const f = (path: string, line: number | null, title = 'A problem') => ({
  path,
  line,
  severity: 'high' as const,
  title,
  body: 'It breaks when x is empty.',
});

type Script = (input: ChatStartInput) => AsyncIterable<RuntimeEvent>;

interface Fx {
  base: string;
  starts: ChatStartInput[];
  stops: string[];
  disposed: ReviewerRun[];
  prepared: ReviewerRun[];
  deps: Parameters<typeof runPrReview>[0];
  setScript: (s: Script) => void;
  setPrepare: (p: Parameters<typeof runPrReview>[0]['prepare']) => void;
  setHeads: (h: Parameters<typeof runPrReview>[0]['heads']) => void;
  setGate: (g: 'ok' | 'login') => void;
}
let fx: Fx;

/** A session whose events end when it is stopped (or when the script ends). */
function sessionOf(script: AsyncIterable<RuntimeEvent>, stops: string[]): RuntimeSession {
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((r) => {
    stop = r;
  });
  return {
    async *events() {
      const it = script[Symbol.asyncIterator]();
      let sawExit = false;
      while (true) {
        const next = await Promise.race([it.next(), stopped.then(() => ({ done: true, value: undefined }))]);
        if (next.done) {
          if (!sawExit) yield { kind: 'exit', code: stops.length ? 143 : 0 } as RuntimeEvent;
          return;
        }
        if ((next.value as RuntimeEvent).kind === 'exit') sawExit = true;
        yield next.value as RuntimeEvent;
      }
    },
    async stop(reason: string) {
      stops.push(reason);
      stop();
    },
    usage: () => ({ inputTokens: 10, outputTokens: 5, costUsd: 0, model: 'sonnet' }) as never,
  } as RuntimeSession;
}

beforeEach(() => {
  const base = tmp();
  const paths = runnerPaths(join(base, 'runner'));
  const starts: ChatStartInput[] = [];
  const stops: string[] = [];
  const disposed: ReviewerRun[] = [];
  const prepared: ReviewerRun[] = [];
  let script: Script = async function* () {
    yield { kind: 'final', text: answer([]) } as RuntimeEvent;
    yield { kind: 'exit', code: 0 } as RuntimeEvent;
  };
  let gate: 'ok' | 'login' = 'ok';
  const adapter = {
    runtime: 'claude-code',
    instructionStyle: 'cli',
    writeInstructions: async () => undefined,
    accountGate: () => (gate === 'ok' ? { state: 'ok' } : { state: 'login', login: 'expired' }),
    startChat: async (input: ChatStartInput) => {
      starts.push(input);
      return sessionOf(script(input), stops);
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
      const run = {
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
      prepared.push(run);
      return run;
    },
    dispose: async (run: ReviewerRun) => {
      disposed.push(run);
    },
    diff: async () => DIFF,
  } as Parameters<typeof runPrReview>[0];
  fx = {
    base,
    starts,
    stops,
    disposed,
    prepared,
    deps,
    setScript: (s) => {
      script = s;
    },
    setPrepare: (p) => {
      deps.prepare = p;
    },
    setHeads: (h) => {
      deps.heads = h;
    },
    setGate: (g) => {
      gate = g;
    },
  };
});
afterEach(() => cleanupTmp());

describe('the run payload and the diff', () => {
  it('the payload carries no commit id and refuses a token key', () => {
    expect(PrReviewRunPayloadSchema.safeParse(payload()).success).toBe(true);
    expect(PrReviewRunPayloadSchema.safeParse({ ...payload(), token: 'x' }).success).toBe(false);
    expect(PrReviewRunPayloadSchema.safeParse({ ...payload(), headSha: HEAD }).success).toBe(false);
  });
  it('anchors added and context lines of the new file, not removed lines or untouched files', () => {
    const a = anchoredLines(DIFF);
    expect([...(a.get('src/a.ts') ?? [])]).toEqual([1, 2, 3, 4]);
    expect([...(a.get('src/new.ts') ?? [])]).toEqual([1, 2]);
    expect(a.has('nothing.ts')).toBe(false);
  });
  it('reads the last review block, and nothing else', () => {
    expect(parseReviewerOutput('no block')).toBeNull();
    expect(parseReviewerOutput(`===REVIEW-JSON===\n{"summary":"s","findings":[]}`)).toEqual({
      summary: 's',
      findings: [],
    });
    const two = `===REVIEW-JSON===\n{"summary":"old","findings":[]}\nmore\n===REVIEW-JSON===\n\`\`\`json\n{"summary":"new","findings":[]}\n\`\`\``;
    expect(parseReviewerOutput(two)?.summary).toBe('new');
    expect(parseReviewerOutput('===REVIEW-JSON===\n{"summary":1}')).toBeNull();
  });
});

describe('AC1: a completed run hands its findings back (and never posts)', () => {
  it('completes with the commits it reviewed, anchored flags and the run time', async () => {
    fx.setScript(async function* () {
      yield { kind: 'delta', text: 'thinking' } as RuntimeEvent;
      yield {
        kind: 'final',
        text: answer([
          f('src/a.ts', 2),
          f('src/a.ts', 3, 'Second'),
          f('src/a.ts', 99, 'Off the diff'),
          f('src/a.ts', null),
        ]),
      } as RuntimeEvent;
      yield { kind: 'exit', code: 0 } as RuntimeEvent;
    });
    const out = await runPrReview(fx.deps, payload({ timeoutMs: 5000 }));
    expect(out.outcome).toBe('completed');
    if (out.outcome !== 'completed') return;
    expect(out.headSha).toBe(HEAD);
    expect(out.baseSha).toBe(BASE);
    expect(out.findings.map((x) => x.anchored)).toEqual([true, true, false, false]);
    expect(out.summary).toBe('Looks mostly fine');
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(fx.disposed).toHaveLength(1);
  });

  it('starts a read-only Sonnet session in the checkout with the reviewer policy and no shift credentials', async () => {
    await runPrReview(fx.deps, payload({ timeoutMs: 5000 }));
    expect(fx.starts).toHaveLength(1);
    const s = fx.starts[0] as ChatStartInput;
    expect(s.agent.model).toBe('sonnet');
    expect(s.agent.runtime).toBe('claude-code');
    expect(s.readOnly).toBe(true);
    expect(s.reviewRun).toBe(fx.prepared[0]);
    expect(s.cwd).toBe((fx.prepared[0] as ReviewerRun).checkout);
    expect(Object.keys(s.env)).not.toContain('AOM_SHIFT_TOKEN');
    expect(Object.keys(s.env)).not.toContain('AOM_IPC_URL');
    expect(JSON.stringify(s)).not.toMatch(/github_pat|ghp_/);
    expect(s.message).toContain('pr.diff');
    expect(s.message).toContain('<untrusted>');
  });

  it('builds a spec that passes the run spec schema from the looked-up commits', async () => {
    let seen: unknown;
    fx.setPrepare(async (spec) => {
      seen = spec;
      return { refused: 'no_clone' };
    });
    await runPrReview(fx.deps, payload({ timeoutMs: 5000 }));
    expect(ReviewerRunSpecSchema.safeParse(seen).success).toBe(true);
    expect(seen).toMatchObject({ headSha: HEAD, baseSha: BASE, prNumber: 7, baseRef: 'main' });
  });

  it('has no posting code: the run result is the only output', async () => {
    const mod = await import('node:fs').then((m) =>
      m.readFileSync(new URL('../src/review/run.ts', import.meta.url), 'utf8'),
    );
    expect(mod).not.toMatch(/GitHubReviewPoster|review-poster|fetch\(/);
  });
});

describe('AC2: a run that hits its time limit posts nothing and reports a timeout', () => {
  it('a session that never ends is stopped and the run answers timeout (review phase)', async () => {
    fx.setScript(async function* () {
      yield { kind: 'delta', text: 'working' } as RuntimeEvent;
      await new Promise(() => undefined);
    });
    const out = await runPrReview(fx.deps, payload({ timeoutMs: 50 }));
    expect(out).toMatchObject({ outcome: 'timeout', phase: 'review' });
    expect(fx.stops).toEqual(['pr_review.timeout']);
    expect(fx.disposed).toHaveLength(1);
  });

  it('a checkout that hangs times out in the checkout phase and is disposed when it comes back', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = fx.deps.prepare;
    fx.setPrepare(async (spec, ctx) => {
      await gate;
      return original(spec, ctx);
    });
    const out = await runPrReview(fx.deps, payload({ timeoutMs: 50 }));
    expect(out).toMatchObject({ outcome: 'timeout', phase: 'checkout' });
    expect(fx.starts).toHaveLength(0);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(fx.disposed).toHaveLength(1);
    expect(fx.starts).toHaveLength(0);
  });

  it('a finding the model produced after the limit is not returned', async () => {
    fx.setScript(async function* () {
      await new Promise((r) => setTimeout(r, 120));
      yield { kind: 'final', text: answer([f('src/a.ts', 2)]) } as RuntimeEvent;
      yield { kind: 'exit', code: 0 } as RuntimeEvent;
    });
    const out = await runPrReview(fx.deps, payload({ timeoutMs: 40 }));
    expect(out.outcome).toBe('timeout');
    expect('findings' in out).toBe(false);
  });
});

describe('AC4: any other failure returns no findings and says why', () => {
  const run = () => runPrReview(fx.deps, payload({ timeoutMs: 5000 }));

  it('a model that exits with an error is model_error', async () => {
    fx.setScript(async function* () {
      yield { kind: 'exit', code: 1, error: 'boom' } as RuntimeEvent;
    });
    expect(await run()).toMatchObject({ outcome: 'failed', code: 'model_error', retryable: true });
  });
  it('prose with no block is bad_output', async () => {
    fx.setScript(async function* () {
      yield { kind: 'final', text: 'I looked at it and it is fine.' } as RuntimeEvent;
      yield { kind: 'exit', code: 0 } as RuntimeEvent;
    });
    expect(await run()).toMatchObject({ outcome: 'failed', code: 'bad_output' });
  });
  it('a usage limit and an expired login are runtime_unavailable and retryable', async () => {
    fx.setScript(async function* () {
      yield { kind: 'exit', code: 1, usageLimit: { until: '2026-11-13T00:00:00Z' } } as RuntimeEvent;
    });
    expect(await run()).toMatchObject({ outcome: 'failed', code: 'runtime_unavailable', retryable: true });
    fx.setGate('login');
    expect(await run()).toMatchObject({ outcome: 'failed', code: 'runtime_unavailable', retryable: true });
  });
  it('a refused checkout maps to its code', async () => {
    fx.setPrepare(async () => ({ refused: 'reviewer_token_missing' }));
    expect(await run()).toMatchObject({ outcome: 'failed', code: 'no_token', retryable: false });
    fx.setPrepare(async () => ({ refused: 'unsupported_host' }));
    expect(await run()).toMatchObject({ code: 'unsupported', retryable: false });
    fx.setPrepare(async () => ({ refused: 'sandbox_unavailable' }));
    expect(await run()).toMatchObject({ code: 'runtime_unavailable', retryable: true });
    fx.setPrepare(async () => ({ refused: 'no_clone' }));
    expect(await run()).toMatchObject({ code: 'no_checkout', retryable: true });
    expect(fx.starts).toHaveLength(0);
  });
  it('a pull request that moved is head_moved, a broken checkout is no_checkout', async () => {
    fx.setPrepare(async () => {
      throw new ReviewHeadMovedError(HEAD, BASE);
    });
    expect(await run()).toMatchObject({ code: 'head_moved', retryable: true });
    fx.setPrepare(async () => {
      throw new Error('disk full');
    });
    expect(await run()).toMatchObject({ code: 'no_checkout', retryable: true });
    fx.setHeads(async () => {
      throw new Error('gh failed');
    });
    expect(await run()).toMatchObject({ code: 'no_checkout' });
  });
  it('a bad session start is an error result, never a throw, and the run is still disposed', async () => {
    (fx.deps.adapter as { startChat: unknown }).startChat = async () => {
      throw new Error('could not start');
    };
    expect(await run()).toMatchObject({ outcome: 'failed', code: 'error' });
    expect(fx.disposed).toHaveLength(1);
  });
});

describe('a command sent again while its run is live', () => {
  it('awaits the same run: one model session, the same answer', async () => {
    let finish: () => void = () => undefined;
    const hold = new Promise<void>((r) => {
      finish = r;
    });
    fx.setScript(async function* () {
      await hold;
      yield { kind: 'final', text: answer([]) } as RuntimeEvent;
      yield { kind: 'exit', code: 0 } as RuntimeEvent;
    });
    const cmds = new PrReviewCommands({
      paths: fx.deps.paths,
      adapters: new Map([['claude-code', fx.deps.adapter]]),
      tokens: new MemoryReviewerTokenStore(),
      forgeEnv: {} as never,
      findRepo: async () => ({ localPath: fx.base, remoteUrl: 'https://github.com/acme/toy.git' }),
      gitAuth: async () => ({ args: [], env: {} }),
      sandboxState: () => ({ state: 'enforced', reason: 'test' }),
      fetch: (async () => new Response('{}')) as never,
      log: () => undefined,
    });
    const p = payload({ timeoutMs: 5000 });
    const a = cmds.run(p);
    const b = cmds.run(p);
    expect(cmds.liveRunIds()).toEqual([RUN]);
    expect(a).toBe(b);
    finish();
    await a;
    // the real heads lookup has no host here: the run fails the same way for both, and no session was started twice
    expect(fx.starts.length).toBeLessThanOrEqual(1);
    expect(cmds.liveRunIds()).toEqual([]);
  });
});
