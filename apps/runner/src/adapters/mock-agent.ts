#!/usr/bin/env node
// Mock agent process (docs/ARCHITECTURE.md section 12.3). Standalone: node builtins only, talks to the runner
// exclusively through the real `aom` CLI. Stdout is JSON lines of RuntimeEvent.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  | 'devops_install'
  | 'fabricate'
  | 'uncited';

interface FeedItem {
  kind: string;
  url: string;
  title: string;
  source: string;
  publishedAt: string;
  summary: string;
}

interface Brief {
  shift: { stage: string; outcomes: Array<{ id: string; kind: string; data: string }> };
  feed?: { candidates: FeedItem[]; seenUrls: string[]; taste?: string };
  standingOrders?: Array<{ title: string }>;
  ledger?: Array<{ title: string; body: string }>;
  card: {
    ref: string;
    title: string;
    cardType: string;
    reworkRound: number;
    fields: Record<string, unknown>;
  };
  handoffs?: Array<{ stage: string; outcome?: string; note?: string }>;
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

async function report(brief: Brief, action: Action): Promise<{ code: number; out: string; err: string }> {
  const stage = brief.shift.stage;
  if (brief.card.cardType === 'research') {
    if (brief.shift.outcomes.some((o) => o.id === 'published')) return checkerWork(brief, action);
    if (brief.shift.outcomes.some((o) => o.id === 'handoff')) return researcherWork(brief);
  }
  if (brief.shift.outcomes.some((o) => o.data === 'candidates' || o.data === 'digest'))
    return feedWork(brief, action);
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
  return aom(args);
}

const DEFAULT_ITEMS: FeedItem[] = [1, 2].map((n) => ({
  kind: 'article',
  url: `https://example.test/${n}`,
  title: `Mock item ${n}`,
  source: 'example.test',
  publishedAt: '2026-10-02',
  summary: `Mock summary of item ${n}`,
}));

const tmpText = (name: string, text: string): string => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mock-agent-'));
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
};
const tmpJson = (name: string, value: unknown): string => tmpText(name, JSON.stringify(value));

/** "Opens" a page the way Claude's WebFetch tool shows up in the runtime stream: the runner records it. */
async function openPage(url: string): Promise<void> {
  emit({ kind: 'tool', name: 'WebFetch', summary: url });
  await sleep(stepMs);
}

const skipTitles = (taste: string | undefined): string[] =>
  [...(taste ?? '').matchAll(/^- Skip \S+ like "([^"]+)"/gm)].map((m) => m[1] as string);

/**
 * Scripted feed work (M5). Scout: opens every page of `card.fields.mockFeed.items` (default: two example items) and
 * hands them off as candidates; action `fabricate` also reports a page it never opened, is rejected by the runner and
 * retries without it. Curator: reads taste.md, takes the candidates (skipping titles the taste file says to skip) up to
 * the card's maximum per kind and posts the digest, optionally proposing a taste rule.
 */
async function feedWork(brief: Brief, action: Action): Promise<{ code: number; out: string; err: string }> {
  const fields = brief.card.fields as {
    mockFeed?: { items?: FeedItem[]; proposeRule?: string };
    maxPerKind?: Record<string, number>;
  };
  const wantsCandidates = brief.shift.outcomes.some((o) => o.data === 'candidates');
  if (wantsCandidates) {
    const items = fields.mockFeed?.items ?? DEFAULT_ITEMS;
    for (const i of items) await openPage(i.url);
    if (action === 'fabricate') {
      const fake: FeedItem = {
        ...DEFAULT_ITEMS[0],
        url: 'https://fabricated.example.test/never-opened',
        title: 'Fabricated item',
      } as FeedItem;
      const first = aom([
        'handoff',
        '--note',
        'mock scout (with a fabricated item)',
        '--data-file',
        tmpJson('candidates.json', { items: [...items, fake] }),
      ]);
      emit({
        kind: 'progress',
        text: `mock scout: first report ${first.code === 0 ? 'accepted' : `rejected: ${first.err.trim()}`}`,
      });
      if (first.code === 0) return first;
    }
    return aom([
      'handoff',
      '--note',
      `mock scout found ${items.length} candidate(s)`,
      '--data-file',
      tmpJson('candidates.json', { items }),
    ]);
  }
  // curator
  const taste = brief.feed?.taste;
  // taste.md as the curator read it at shift start: one progress line per rule (progress lines are short)
  const tasteLines = (taste ?? '').split('\n').filter((l) => l.startsWith('- '));
  emit({ kind: 'progress', text: `mock taste: ${taste ? `${tasteLines.length} rule line(s)` : 'none'}` });
  for (const l of tasteLines) emit({ kind: 'progress', text: `mock taste rule: ${l.slice(0, 400)}` });
  const skip = skipTitles(taste);
  const max = fields.maxPerKind ?? { article: 5, video: 3 };
  const used: Record<string, number> = {};
  const picked: FeedItem[] = [];
  for (const c of brief.feed?.candidates ?? []) {
    if (skip.includes(c.title)) continue;
    if ((used[c.kind] ?? 0) >= (max[c.kind] ?? 0)) continue;
    used[c.kind] = (used[c.kind] ?? 0) + 1;
    picked.push(c);
  }
  const data: Record<string, unknown> = { items: picked };
  if (fields.mockFeed?.proposeRule && picked[0])
    data.tasteRuleProposal = { rule: fields.mockFeed.proposeRule, evidenceUrls: [picked[0].url] };
  if (picked.length === 0) return aom(['digest', '--none', '--note', 'mock curator: nothing qualified']);
  return aom([
    'digest',
    '--file',
    tmpJson('digest.json', data),
    '--note',
    `mock curator picked ${picked.length} of ${brief.feed?.candidates.length ?? 0}`,
  ]);
}

interface MockClaim {
  text: string;
  url: string;
  title?: string;
  supported?: boolean;
}

const DEFAULT_CLAIMS: MockClaim[] = [1, 2].map((n) => ({
  text: `Mock claim ${n} about the question`,
  url: `https://example.test/research/${n}`,
  title: `Mock source ${n}`,
}));

const claimsOf = (brief: Brief): MockClaim[] =>
  (brief.card.fields as { mockResearch?: { claims?: MockClaim[] } }).mockResearch?.claims ?? DEFAULT_CLAIMS;

/**
 * Scripted research (M6). Researcher: opens the page behind each scripted claim and hands off a draft that lists every
 * claim with its numbered reference; in a rework round it drops the claims the fact checker could not verify (those
 * with `supported: false`). Checker: sends the card back (`unsupported`) while the draft still contains an unsupported
 * claim; otherwise opens every cited page and publishes the note with its citations. Action `uncited` first tries to
 * publish without citations (the runner refuses) and then does it properly; action `fail` always sends it back.
 */
async function researcherWork(brief: Brief): Promise<{ code: number; out: string; err: string }> {
  const all = claimsOf(brief);
  const claims = brief.card.reworkRound > 0 ? all.filter((c) => c.supported !== false) : all;
  for (const c of claims) await openPage(c.url);
  const question = (brief.card.fields as { question?: string }).question ?? brief.card.title;
  const draft = [
    `# ${brief.card.title}`,
    '',
    `Question: ${question}`,
    '',
    ...claims.map((c, i) => `- ${c.text} [${i + 1}]`),
    '',
    'References',
    ...claims.map((c, i) => `${i + 1}. ${c.title ?? c.url} - ${c.url}`),
    '',
  ].join('\n');
  const file = tmpText('draft.md', draft);
  return aom(['handoff', '--note-file', file]);
}

async function checkerWork(
  brief: Brief,
  action: Action,
): Promise<{ code: number; out: string; err: string }> {
  const draft = [...(brief.handoffs ?? [])].reverse().find((h) => h.stage === 'research')?.note ?? '';
  const refs = [...draft.matchAll(/^\d+\.\s+(.*?)\s+-\s+(https?:\/\/\S+)\s*$/gm)].map((m) => ({
    title: m[1] as string,
    url: m[2] as string,
  }));
  const bad = claimsOf(brief).filter((c) => c.supported === false && draft.includes(c.text));
  if (action === 'fail' || bad.length > 0) {
    const what = bad.length ? bad.map((c) => `"${c.text}"`).join('; ') : 'a claim';
    return aom(['outcome', 'unsupported', '--note', `Not supported by the cited page: ${what}`]);
  }
  const title = brief.card.title;
  const noteFile = tmpText('note.md', `# ${title}\n\n${draft.replace(/^# .*\n/, '').trim()}\n`);
  if (action === 'uncited') {
    const first = aom(['publish', '--file', noteFile, '--title', title]);
    emit({
      kind: 'progress',
      text: `mock checker: publishing without citations ${first.code === 0 ? 'was accepted' : `was refused: ${first.err.trim().slice(0, 200)}`}`,
    });
    if (first.code === 0) return first;
  }
  for (const r of refs) await openPage(r.url);
  const cites = tmpJson(
    'citations.json',
    refs.map((r) => ({ url: r.url, title: r.title })),
  );
  return aom([
    'publish',
    '--file',
    noteFile,
    '--title',
    title,
    '--citations-file',
    cites,
    '--note',
    `Verified ${refs.length} source(s); published`,
  ]);
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

  const r = await report(brief, action);
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
