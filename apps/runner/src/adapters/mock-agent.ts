#!/usr/bin/env node
// Mock agent process (docs/ARCHITECTURE.md section 12.3). Standalone: node builtins only, talks to the runner
// exclusively through the real `aom` CLI. Stdout is JSON lines of RuntimeEvent.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Action =
  | 'ok'
  | 'changes'
  | 'fail'
  | 'question'
  | 'crash'
  | 'hang'
  | 'no_report'
  | 'edit_outside_scope'
  | 'devops'
  | 'devops_install';

interface Brief {
  shift: { stage: string; outcomes: Array<{ id: string; kind: string; data: string }> };
  standingOrders?: Array<{ title: string }>;
  ledger?: Array<{ title: string; body: string }>;
  card: { ref: string; title: string; reworkRound: number; fields: Record<string, unknown> };
  handoffs?: Array<{ stage: string }>;
}

const emit = (ev: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(ev)}\n`);
const stepMs = Number(process.env.AOM_MOCK_STEP_MS) || 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function aom(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync('aom', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  return {
    code: r.status ?? 1,
    out: r.stdout ?? '',
    err: (r.stderr ?? '') + (r.error ? String(r.error) : ''),
  };
}

function sh(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
}

/** How many shifts of this card+stage ran before this one (persisted so crashed shifts still count). */
function attemptIndex(brief: Brief): number {
  const dir = process.env.AOM_MOCK_STATE_DIR;
  if (!dir) return (brief.handoffs ?? []).filter((h) => h.stage === brief.shift.stage).length;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${brief.card.ref}.${brief.shift.stage}.count`);
  let n = 0;
  try {
    n = Number.parseInt(readFileSync(file, 'utf8'), 10) || 0;
  } catch {
    // first attempt
  }
  writeFileSync(file, String(n + 1));
  return n;
}

function pickAction(brief: Brief, index: number): Action {
  const script = brief.card.fields.mock;
  if (script && typeof script === 'object') {
    const list = (script as Record<string, unknown>)[brief.shift.stage];
    if (Array.isArray(list) && typeof list[index] === 'string') return list[index] as Action;
  }
  return 'ok';
}

function buildWork(brief: Brief): void {
  const round = brief.card.reworkRound + 1;
  mkdirSync('aom-mock', { recursive: true });
  writeFileSync(join('aom-mock', `${brief.card.ref}.txt`), `round ${round}\n${brief.card.title}\n`);
  writeFileSync(
    join('aom-mock', `${brief.card.ref}.test.txt`),
    `unit-test-like file for ${brief.card.ref}, round ${round}\n`,
  );
  sh('git', ['add', '-A']);
  sh('git', ['commit', '--no-verify', '--allow-empty', '-m', `mock build round ${round}: ${brief.card.ref}`]);
}

function report(brief: Brief, action: Action): { code: number; out: string; err: string } {
  const stage = brief.shift.stage;
  const failing = action === 'changes' || action === 'fail';
  const outcomes = brief.shift.outcomes;
  const has = (id: string) => outcomes.some((o) => o.id === id);

  if (has('handoff') && !failing)
    return aom(['handoff', '--note', `mock ${stage} round ${brief.card.reworkRound + 1}`]);
  if (has('approve') && has('changes')) {
    return failing
      ? aom([
          'review',
          'changes',
          '--reason',
          'missed_requirement',
          '--score',
          '2',
          '--criteria-missed',
          'mock criterion',
          '--note',
          'mock: changes requested',
        ])
      : aom(['review', 'approve', '--score', '4', '--note', 'mock approve']);
  }
  if (has('pass') && has('fail')) {
    return failing
      ? aom(['test', 'fail', '--title', 'Mock bug', '--note', 'mock failure', '--evidence', 'mock: 1 failed'])
      : aom(['test', 'pass', '--evidence', 'mock: 1 passed', '--command', 'mock test']);
  }
  const wanted = outcomes.find((o) => o.kind === (failing ? 'failure' : 'success')) ?? outcomes[0];
  if (!wanted) return { code: 1, out: '', err: `no outcomes for stage ${stage}` };
  const args = ['outcome', wanted.id, '--note', `mock ${stage} ${wanted.id}`];
  if (wanted.data === 'digest') {
    const f = join(process.env.TMPDIR ?? tmpdir(), 'mock-digest.json');
    writeFileSync(
      f,
      JSON.stringify({
        items: [1, 2].map((n) => ({
          title: `Mock item ${n}`,
          url: `https://example.test/${n}`,
          kind: 'article',
        })),
      }),
    );
    args.push('--data-file', f);
  }
  return aom(args);
}

interface DevopsBrief extends Brief {
  devops: {
    summary: string;
    access: { allowInstall: boolean; allowDocker: boolean; allowedPaths: string[]; sudo: boolean };
    approval?: { action: string };
  };
}

/**
 * DevOps shift (docs/ARCHITECTURE.md section 16.2). Deterministic: a request that needs more than the granted access
 * (see `needsApproval`) asks for approval unless the manager already approved it; anything else is "done". Tokens in
 * the request text drive failure paths: `[crash]`, `[hang]`, `[no_report]`.
 */
async function devopsMain(brief: DevopsBrief): Promise<number> {
  // Loaded lazily: card shifts must start as fast as before (zod is not needed for them).
  const { needsApproval } = await import('@aom/shared/devops');
  const d = brief.devops;
  for (let i = 1; i <= 3; i++) {
    emit({ kind: 'progress', text: `mock devops: step ${i}/3 (${d.summary.slice(0, 60)})` });
    await sleep(stepMs);
  }
  emit({ kind: 'usage', usage: { inputTokens: 500, outputTokens: 100 } });
  if (d.summary.includes('[crash]')) {
    process.stderr.write('mock devops crash\n');
    return 1;
  }
  if (d.summary.includes('[hang]')) {
    for (;;) {
      emit({ kind: 'progress', text: 'mock hanging' });
      await sleep(100);
    }
  }
  if (d.summary.includes('[no_report]')) {
    emit({ kind: 'final', text: 'mock devops finished without reporting' });
    return 0;
  }
  const r =
    !d.approval && needsApproval(d.access, d.summary)
      ? aom([
          'devops-approval',
          '--action',
          d.summary,
          '--reason',
          'mock: outside the access granted to the DevOps engineer',
          '--command',
          `mock: ${d.summary}`,
        ])
      : aom(['devops-done', '--summary', `mock: ${d.summary}`, '--command', 'mock: echo done']);
  emit({
    kind: 'final',
    text:
      r.code === 0
        ? `mock devops reported: ${r.out.trim()}`
        : `mock devops report failed: ${(r.err || r.out).trim()}`,
  });
  return 0;
}

async function main(): Promise<number> {
  const card = aom(['card', '--json']);
  if (card.code !== 0) {
    process.stderr.write(`aom card failed: ${card.err}\n`);
    return 1;
  }
  const brief = JSON.parse(card.out) as Brief;
  if ((brief.shift as { kind?: string }).kind === 'devops') return devopsMain(brief as DevopsBrief);
  const stage = brief.shift.stage;
  const action = pickAction(brief, attemptIndex(brief));

  // What the shift prompt carries from the ledger (answers to earlier questions, standing orders): visible in the log.
  emit({
    kind: 'progress',
    text: `mock ledger: ${(brief.ledger ?? []).map((l) => l.body.replace(/\s+/g, ' ')).join(' | ') || 'none'}; standing orders: ${(brief.standingOrders ?? []).map((o) => o.title).join(' | ') || 'none'}`,
  });
  for (let i = 1; i <= 3; i++) {
    emit({ kind: 'progress', text: `mock ${brief.card.ref} ${stage}: step ${i}/3 (${action})` });
    await sleep(stepMs);
  }
  emit({ kind: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } });

  if (action === 'crash') {
    process.stderr.write('mock crash\n');
    return 1;
  }
  if (action === 'hang') {
    for (;;) {
      emit({ kind: 'progress', text: 'mock hanging' });
      await sleep(100);
    }
  }

  if (action === 'devops' || action === 'devops_install') {
    // Ask this workstation's DevOps engineer (non-terminal), then carry on with the stage as usual.
    const asked = aom(['devops', action === 'devops' ? 'start the app' : 'install docker']);
    emit({
      kind: 'progress',
      text: `mock asked DevOps: ${(asked.code === 0 ? asked.out : asked.err).trim()}`,
    });
  }
  if (stage === 'build') buildWork(brief);
  if (action === 'edit_outside_scope') {
    mkdirSync('aom-mock', { recursive: true });
    writeFileSync(join('aom-mock', 'outside-scope.txt'), 'edited outside the role scope\n');
  }
  if (action === 'no_report') {
    emit({ kind: 'final', text: 'mock finished without reporting' });
    return 0;
  }
  if (action === 'question') {
    const q = aom([
      'question',
      '--text',
      `Mock question for ${brief.card.ref}?`,
      '--option',
      'yes',
      '--option',
      'no',
      '--recommend',
      '0',
      '--doing',
      `mock ${stage}`,
    ]);
    emit({ kind: 'final', text: `mock question: ${q.code === 0 ? q.out.trim() : q.err.trim()}` });
    return 0;
  }

  const r = report(brief, action);
  emit({
    kind: 'final',
    text: r.code === 0 ? `mock reported: ${r.out.trim()}` : `mock report failed: ${(r.err || r.out).trim()}`,
  });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`mock agent error: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
