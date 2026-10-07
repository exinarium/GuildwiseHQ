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
  | 'uncited'
  | 'answer'
  | 'escalate';

interface FeedItem {
  kind: string;
  url: string;
  title: string;
  source: string;
  publishedAt: string;
  summary: string;
  transcript?: { status: string; path?: string };
}

interface Brief {
  shift: { stage: string; kind?: string; outcomes: Array<{ id: string; kind: string; data: string }> };
  question?: {
    deskItemId: string;
    level: string;
    text: string;
    recommendation?: string;
    ledgerMatches: Array<{ title: string; body: string }>;
  };
  feed?: { candidates: FeedItem[]; seenUrls: string[]; taste?: string; tasteSeed?: string[] };
  standingOrders?: Array<{ title: string }>;
  ledger?: Array<{ title: string; body: string }>;
  card: {
    ref: string;
    title: string;
    cardType: string;
    reworkRound: number;
    completionAction?: string | null;
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
  // M7: the BA claims Finalize and runs the card's completion action (a different `--action` would revise it).
  if (has('finalized')) {
    // M8: a card that came from a ticket gets its outside update drafted first (`fields.mockOutbound` overrides the text;
    // a blocked draft is rewritten once, as the real BA would).
    if (typeof brief.card.fields.externalRef === 'string' && brief.card.fields.externalRef.trim()) {
      const mock = (brief.card.fields.mockOutbound ?? {}) as { kind?: string; body?: string };
      const clean = `${brief.card.title} is done and ready.`;
      for (const body of [mock.body, clean].filter((b): b is string => !!b)) {
        if (aom(['outbound', 'draft', '--kind', mock.kind ?? 'resolution', '--body', body]).code === 0) break;
      }
    }
    return aom([
      'finalize',
      '--action',
      brief.card.completionAction ?? 'push_branch',
      '--note',
      `mock BA: ${brief.card.ref} is ready`,
    ]);
  }
  const wanted = outcomes.find((o) => o.kind === (failing ? 'failure' : 'success')) ?? outcomes[0];
  if (!wanted) return { code: 1, out: '', err: `no outcomes for stage ${stage}` };
  const args = ['outcome', wanted.id, '--note', `mock ${stage} ${wanted.id}`];
  return aom(args);
}

const DEFAULT_ITEMS: FeedItem[] = [
  ...[1, 2].map((n) => ({
    kind: 'article',
    url: `https://example.test/${n}`,
    title: `Mock item ${n}`,
    source: 'example.test',
    publishedAt: '2026-10-02',
    summary: `Mock summary of item ${n}`,
  })),
  // The mock runtime answers `aom transcript` for it with a fake transcript.
  {
    kind: 'video',
    url: 'https://video.example.test/watch/3',
    title: 'Mock video 3',
    source: 'video.example.test',
    publishedAt: '2026-10-02',
    summary: 'Mock summary of video 3',
  },
];

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
    maxItems?: number;
    maxPerKind?: Record<string, number>;
  };
  const wantsCandidates = brief.shift.outcomes.some((o) => o.data === 'candidates');
  if (wantsCandidates) {
    const items = fields.mockFeed?.items ?? DEFAULT_ITEMS;
    for (const i of items) await openPage(i.url);
    // Videos and podcasts: the scout looks up their transcript (the runner stores it and attaches the reference).
    for (const i of items.filter((x) => x.kind === 'video' || x.kind === 'podcast')) {
      const t = aom(['transcript', '--url', i.url]);
      emit({
        kind: 'progress',
        text: `mock scout: transcript of ${i.url}: ${t.out.split('\n')[0]?.trim() ?? ''}`.slice(0, 300),
      });
    }
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
  // Explicit rules the manager set on the Interests page (docs/design/interests.md): `skip "<title>"` drops a candidate.
  const seed = brief.feed?.tasteSeed ?? [];
  emit({ kind: 'progress', text: `mock taste seed: ${seed.length} rule(s)` });
  for (const r of seed) emit({ kind: 'progress', text: `mock taste seed rule: ${r.slice(0, 400)}` });
  if (taste?.includes('aom:section'))
    emit({ kind: 'progress', text: 'mock taste: managed section NOT stripped' });
  else emit({ kind: 'progress', text: 'mock taste: managed section stripped' });
  const skip = [
    ...skipTitles(taste),
    ...seed.flatMap((r) => [...r.matchAll(/skip "([^"]+)"/gi)].map((m) => m[1] as string)),
  ];
  // One top-N across kinds (a legacy per-kind maximum counts as the sum of its values).
  const max =
    fields.maxItems ??
    (fields.maxPerKind ? Object.values(fields.maxPerKind).reduce((a, b) => a + b, 0) || 10 : 10);
  const picked: FeedItem[] = [];
  for (const c of brief.feed?.candidates ?? []) {
    if (skip.includes(c.title)) continue;
    if (picked.length >= max) break;
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
  /** `video` or `podcast`: the researcher and the checker fetch its transcript with `aom transcript`. */
  kind?: string;
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
  for (const c of claims) {
    await openPage(c.url);
    if (c.kind === 'video' || c.kind === 'podcast') {
      const t = aom(['transcript', '--url', c.url]);
      emit({
        kind: 'progress',
        text: `mock researcher: transcript of ${c.url}: ${t.out.split('\n')[0]?.trim() ?? ''}`.slice(0, 300),
      });
    }
  }
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
  const media = new Set(
    claimsOf(brief)
      .filter((c) => c.kind === 'video' || c.kind === 'podcast')
      .map((c) => c.url),
  );
  for (const r of refs) {
    // A video or podcast source is verified against its transcript (which also counts as opening it).
    if (media.has(r.url)) aom(['transcript', '--url', r.url]);
    else await openPage(r.url);
  }
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
    hygiene?: { repos: unknown[] };
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
  // M4: fixing the test environment is what lets the runner's mock environment check pass (see testing/environment.ts).
  markEnvironmentFixed(d.summary);
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
  // Repository hygiene: the deterministic `aom hygiene run` does the git work (and ends the request).
  if (d.hygiene) {
    const h = aom(['hygiene', 'run']);
    emit({
      kind: 'final',
      text:
        h.code === 0
          ? `mock devops hygiene: ${h.out.trim().split('\n')[0]}`
          : `mock devops hygiene failed: ${(h.err || h.out).trim()}`,
    });
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

/** The mock DevOps engineer "installs docker" / "starts the app": drops the marker the mock tester check looks for. */
function markEnvironmentFixed(summary: string): void {
  const dir = process.env.AOM_MOCK_STATE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  if (/docker/i.test(summary)) writeFileSync(join(dir, 'env-ok-docker_missing'), 'ok\n');
  if (/\b(app|start|deploy)/i.test(summary)) writeFileSync(join(dir, 'env-ok-app_not_deployed'), 'ok\n');
}

/**
 * A question shift (M7): a colleague's question reached this agent along the escalation chain. Deterministic: the
 * card's `mock.question` script (consumed per question shift of the card) says `answer` (default) or `escalate`.
 * An answer quotes the first ledger entry that matched, else follows the asker's recommendation.
 */
async function questionMain(brief: Brief): Promise<number> {
  const q = brief.question;
  if (!q) return 1;
  const script = (brief.card.fields.mock as Record<string, unknown> | undefined)?.question;
  const index = attemptIndex(brief);
  const action: Action =
    Array.isArray(script) && typeof script[index] === 'string' ? (script[index] as Action) : 'answer';
  for (let i = 1; i <= 2; i++) {
    emit({ kind: 'progress', text: `mock ${brief.card.ref} question (${q.level}): step ${i}/2 (${action})` });
    await sleep(stepMs);
  }
  emit({ kind: 'usage', usage: { inputTokens: 400, outputTokens: 80 } });
  const r =
    action === 'escalate'
      ? aom([
          'escalate',
          '--item',
          q.deskItemId,
          '--note',
          `mock ${q.level}: cannot settle "${q.text.slice(0, 60)}"`,
        ])
      : aom([
          'answer',
          '--item',
          q.deskItemId,
          '--text',
          q.ledgerMatches[0]
            ? `mock answer from the ledger: ${q.ledgerMatches[0].body.replace(/\s+/g, ' ').slice(0, 300)}`
            : `mock answer: ${q.recommendation ? 'go with the recommended option' : 'proceed with your best judgement'}`,
          ...(q.recommendation ? ['--option', q.recommendation] : []),
        ]);
  emit({
    kind: 'final',
    text:
      r.code === 0 ? `mock question: ${r.out.trim()}` : `mock question failed: ${(r.err || r.out).trim()}`,
  });
  return 0;
}

interface BaTaskBrief extends Brief {
  baTask: {
    kind:
      | 'phase_report'
      | 'followups_brief'
      | 'followup_custom'
      | 'followups_report'
      | 'desk_triage'
      | 'urgent_note'
      | 'floor_alert'
      | 'floor_report'
      | 'scheduled_brief';
    followupId?: string;
    phase?: { ref: string; name: string; description: string; workingBranch: string };
    reporter?: {
      brief?: { scheduleName: string; instructions: string; deliver: string; projectKey?: string | null };
      items: Array<{ id: string; title: string; held: boolean }>;
      openItems: Array<{ id: string; title: string }>;
      signals: Array<{
        id: string;
        kind: string;
        urgency: string;
        count: number;
        subject: { title: string; detail: string; deskItemId?: string };
      }>;
      digest?: {
        localDate: string;
        phases: Array<{ ref: string; name: string; status: string; lateBugs: string[] }>;
        signals: Array<{ kind: string; count: number; subject: { title: string; detail: string } }>;
        backingOff: Array<{ ref: string; title: string; failures: number }>;
        devopsOpen: Array<{ summary: string; status: string }>;
        resolvedByBa: Array<{ title: string; how: string }>;
        failures: Array<{ ref: string; failedShifts: number }>;
      };
    };
    cards: Array<{
      ref: string;
      title: string;
      outcome: string;
      action?: string;
      resultRef?: { mergeCommit?: string; prUrl?: string; pushedBranch?: string };
      reason?: string;
      unmergedBranch?: string;
      suite?: { ref: string; result?: string; bugRefs: string[] };
    }>;
    followups: Array<{
      id: string;
      position: number;
      kind: 'deploy' | 'regression' | 'custom';
      target: { name: string; kind: string; appUrl: string | null } | null;
      instruction: string;
      note: string;
      status: string;
      resultSummary: string | null;
    }>;
    outstanding: Array<{ text: string }>;
  };
}

/**
 * A BA reporter task (Part B), scripted and deterministic. Triage: `[dismiss]` in an item title dismisses it, `[merge]`
 * merges it into the first open item, anything else is passed with a note; `[ba_no_report]` ends the shift without
 * reporting (the held items then reach the manager unchanged). Notes: one note per item. Signals: one analysis per
 * signal, written onto the signal's own desk item when it has one. Floor: the six sections from the digest.
 */
async function reporterTaskMain(
  t: BaTaskBrief['baTask'] & { reporter: NonNullable<BaTaskBrief['baTask']['reporter']> },
): Promise<number> {
  const r = t.reporter;
  for (let i = 1; i <= 2; i++) {
    emit({ kind: 'progress', text: `mock BA ${t.kind}: step ${i}/2` });
    await sleep(stepMs);
  }
  emit({ kind: 'usage', usage: { inputTokens: 500, outputTokens: 120 } });
  const silent = [...r.items.map((i) => i.title), ...r.signals.map((s) => s.subject.title)].some((x) =>
    x.includes('[ba_no_report]'),
  );
  if (silent) {
    emit({ kind: 'final', text: 'mock BA finished without reporting' });
    return 0;
  }
  let res: { code: number; out: string; err: string };
  if (t.kind === 'desk_triage') {
    const decisions = r.items.map((i) => {
      if (i.title.includes('[dismiss]'))
        return { itemId: i.id, action: 'dismiss', note: 'mock: duplicate of something already known' };
      const into = i.title.includes('[merge]') ? r.openItems[0]?.id : undefined;
      if (into) return { itemId: i.id, action: 'merge', into, note: 'mock: same as the open item' };
      return { itemId: i.id, action: 'pass', note: `mock: looked at "${i.title}"` };
    });
    res = aom(['report', 'triage', '--file', tmpJson('decisions.json', { decisions })]);
  } else if (t.kind === 'urgent_note') {
    const notes = r.items.map((i) => ({ itemId: i.id, note: `mock note: the BA saw "${i.title}"` }));
    res = aom(['report', 'notes', '--file', tmpJson('notes.json', { notes })]);
  } else if (t.kind === 'floor_alert') {
    const reports = r.signals.map((s) => ({
      signalId: s.id,
      summary: `mock analysis of ${s.kind}: ${s.subject.title}\n\n${s.subject.detail}`,
      ...(s.subject.deskItemId ? { annotateItemId: s.subject.deskItemId } : {}),
    }));
    res = aom(['report', 'signals', '--file', tmpJson('reports.json', { reports })]);
  } else if (t.kind === 'scheduled_brief') {
    const b = r.brief;
    const md = [
      `# ${b?.scheduleName ?? 'Scheduled task'} (mock BA)`,
      '',
      `Instructions: ${b?.instructions ?? ''}`,
      '',
      'The mock BA read the instructions and has nothing to add.',
    ].join('\n');
    res = aom(['report', 'brief', '--summary-file', tmpText('brief.md', md)]);
  } else {
    const d = r.digest;
    const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`) : ['- none']);
    const md = [
      `# Floor report ${d?.localDate ?? ''} (mock BA)`,
      '',
      '## Phases waiting or open',
      ...list(
        (d?.phases ?? []).map(
          (p) =>
            `${p.ref} ${p.name}: ${p.status}${p.lateBugs.length ? ` (late bugs ${p.lateBugs.join(', ')})` : ''}`,
        ),
      ),
      '',
      '## Stuck, blocked and backing-off cards',
      ...list([
        ...(d?.signals ?? [])
          .filter((s) => ['blocked', 'unclaimed', 'loop'].includes(s.kind))
          .map((s) => s.subject.title),
        ...(d?.backingOff ?? []).map((b) => `${b.ref} backing off after ${b.failures} failed shifts`),
      ]),
      '',
      '## Repeated approvals',
      ...list(
        (d?.signals ?? [])
          .filter((s) => s.kind === 'repeated_approval')
          .map((s) => `${s.subject.title} (${s.count}x)`),
      ),
      '',
      '## Failures',
      ...list([
        ...(d?.signals ?? [])
          .filter((s) => ['rework', 'finalize_failures', 'repo_hygiene'].includes(s.kind))
          .map((s) => s.subject.title),
        ...(d?.failures ?? []).map((f) => `${f.ref}: ${f.failedShifts} failed shifts`),
      ]),
      '',
      '## DevOps requests that are open',
      ...list((d?.devopsOpen ?? []).map((x) => `${x.summary}: ${x.status}`)),
      '',
      '## Resolved without bothering you',
      ...list((d?.resolvedByBa ?? []).map((x) => `${x.title} (${x.how})`)),
    ].join('\n');
    res = aom(['report', 'floor', '--summary-file', tmpText('floor.md', md)]);
  }
  emit({
    kind: 'final',
    text:
      res.code === 0
        ? `mock reporter ${t.kind}: ${res.out.trim()}`
        : `mock reporter ${t.kind} failed: ${(res.err || res.out).trim()}`,
  });
  return res.code === 0 ? 0 : 1;
}

/**
 * A BA background task (phases), scripted and deterministic. Report: markdown from the cards, the open pull requests
 * and the suites as the outstanding items. Briefs: one `aom phase followup brief` per queued follow-up (the note or
 * instruction travels into the brief, so tokens like `[no_report]` reach the mock DevOps engineer), then `ready`.
 * Custom: `[fail]` in the instruction fails it. Results: one line per follow-up. `[ba_no_report]` in the phase
 * description ends the shift without reporting (retries, then the server's template).
 */
async function baTaskMain(brief: BaTaskBrief): Promise<number> {
  const t = brief.baTask;
  if (t.reporter)
    return reporterTaskMain(
      t as BaTaskBrief['baTask'] & { reporter: NonNullable<BaTaskBrief['baTask']['reporter']> },
    );
  const phase = t.phase as NonNullable<BaTaskBrief['baTask']['phase']>;
  for (let i = 1; i <= 2; i++) {
    emit({ kind: 'progress', text: `mock BA ${phase.ref} ${t.kind}: step ${i}/2` });
    await sleep(stepMs);
  }
  emit({ kind: 'usage', usage: { inputTokens: 600, outputTokens: 150 } });
  if (phase.description.includes('[ba_no_report]')) {
    emit({ kind: 'final', text: 'mock BA finished without reporting' });
    return 0;
  }
  const cardLine = (c: BaTaskBrief['baTask']['cards'][number]) =>
    `- ${c.ref} ${c.title}: ${c.outcome}${c.resultRef?.mergeCommit ? ` (${c.resultRef.mergeCommit.slice(0, 10)})` : ''}${c.resultRef?.prUrl ? ` ${c.resultRef.prUrl}` : ''}${c.reason ? ` (${c.reason})` : ''}${c.suite ? `; full suite ${c.suite.ref}: ${c.suite.result ?? 'running'}` : ''}`;
  let r: { code: number; out: string; err: string };
  if (t.kind === 'phase_report') {
    const md = [
      `# ${phase.ref} ${phase.name} is done`,
      '',
      '## Delivered',
      ...t.cards.map(cardLine),
      '',
      '## Follow-ups if you approve',
      ...(t.followups.length
        ? t.followups.map(
            (f) =>
              `${f.position}. ${f.kind}${f.target ? ` to ${f.target.name}` : ''}${f.instruction ? `: ${f.instruction}` : ''}`,
          )
        : ['none']),
    ].join('\n');
    r = aom([
      'phase',
      'report',
      '--summary-file',
      tmpText('report.md', md),
      ...t.outstanding.flatMap((o) => ['--outstanding', o.text]),
    ]);
  } else if (t.kind === 'followups_brief') {
    r = { code: 0, out: '', err: '' };
    for (const f of t.followups.filter((x) => x.status === 'queued' || x.status === 'briefed')) {
      const to =
        f.kind === 'deploy'
          ? 'devops'
          : f.kind === 'regression'
            ? 'tester'
            : f.instruction.includes('[ba]')
              ? 'ba'
              : f.instruction.includes('[tester]')
                ? 'tester'
                : 'devops';
      const what =
        f.kind === 'deploy'
          ? `deploy ${f.target?.name ?? ''} ${f.target?.appUrl ?? ''}`.trim()
          : f.kind === 'regression'
            ? `run the regression suite${f.target ? ` against ${f.target.name}` : ''}`
            : f.instruction;
      const b = aom([
        'phase',
        'followup',
        'brief',
        String(f.position),
        '--to',
        to,
        '--text',
        `mock brief: ${what} ${f.note}`.trim(),
      ]);
      if (b.code !== 0) r = b;
    }
    if (r.code === 0) r = aom(['phase', 'ready', '--note', 'mock: every follow-up is briefed']);
  } else if (t.kind === 'followup_custom') {
    const f = t.followups.find((x) => x.id === t.followupId);
    if (!f) return 1;
    r = f.instruction.includes('[fail]')
      ? aom([
          'phase',
          'followup',
          'fail',
          String(f.position),
          '--summary',
          `mock: could not do "${f.instruction}"`,
        ])
      : aom(['phase', 'followup', 'done', String(f.position), '--summary', `mock: did ${f.instruction}`]);
  } else {
    const md = [
      `# ${phase.ref} follow-ups finished`,
      '',
      ...t.followups.map(
        (f) =>
          `${f.position}. ${f.kind}: ${f.status}${f.resultSummary ? ` - ${f.resultSummary.split('\n')[0]}` : ''}`,
      ),
    ].join('\n');
    r = aom(['phase', 'results', '--summary-file', tmpText('results.md', md)]);
  }
  emit({
    kind: 'final',
    text:
      r.code === 0
        ? `mock BA reported: ${r.out.trim()}`
        : `mock BA report failed: ${(r.err || r.out).trim()}`,
  });
  return 0;
}

interface MockSource {
  title?: string;
  body?: string;
  /** The project key a ticket maps to (what the BA works out from its ledger and the project list). */
  project?: string;
  completionAction?: string;
  repo?: string;
  docsNeeded?: boolean;
  acceptanceCriteria?: string[];
  mock?: unknown;
  /** Several cards from one ticket: `dependsOn` lists indexes of earlier cards. */
  cards?: Array<MockSource & { dependsOn?: number[]; phase?: boolean }>;
  /** Phases: the BA proposes this phase (reusing an open one with the name) and puts the cards marked `phase: true` in it. */
  phase?: { name: string; description?: string; followups?: unknown[] };
}

interface IntakeCtx {
  externalSystem?: string;
  externalKey?: string;
  mappedProjectKey?: string;
  projects: Array<{ key: string; name: string; repos: string[] }>;
  cards: Array<{ ref: string; title: string; status: string }>;
}

/**
 * The BA's intake chat (M7), scripted. It reads the ticket (GitHub: `aom source read` through the runner's `gh`;
 * Jira: the "skill", i.e. a fixture file under `$AOM_MOCK_SOURCES_DIR/<KEY>.json`), maps it to a project (a project key
 * equal to the Jira prefix, a project repo named like the GitHub repo, the fixture's `project`, or the only project),
 * asks the desk when nothing fits, then drafts one card per fixture card (default: one) and specifies them.
 */
async function intakeMain(): Promise<number> {
  const ctx = (JSON.parse(process.env.AOM_MOCK_CONTEXT ?? '{}') as { intake?: IntakeCtx }).intake;
  if (!ctx) return 1;
  const message = process.env.AOM_MOCK_MESSAGE ?? '';
  const said: string[] = [];
  const say = (text: string) => {
    said.push(text);
    emit({ kind: 'delta', text: `${text}\n` });
  };
  emit({ kind: 'session', runtimeSessionId: process.env.AOM_MOCK_SESSION ?? 'mock-intake' });
  emit({ kind: 'usage', usage: { inputTokens: message.length, outputTokens: 120 } });
  const finish = (): number => {
    emit({ kind: 'final', text: said.join('\n') });
    return 0;
  };

  let source: MockSource = { title: message.replace(/\s+/g, ' ').slice(0, 80), body: message };
  const key = ctx.externalKey;
  if (key && ctx.externalSystem === 'github') {
    emit({ kind: 'tool', name: 'Bash', summary: `aom source read --ref ${key}` });
    const r = aom(['source', 'read', '--ref', key]);
    if (r.code !== 0) {
      say(`I could not read ${key}: ${(r.err || r.out).trim()}`);
      return finish();
    }
    const [head = '', ...rest] = r.out.split('\n');
    source = { title: head.replace(`${key}:`, '').trim(), body: rest.join('\n').trim() };
    say(`Read GitHub issue ${key}: ${source.title}`);
  } else if (key) {
    emit({ kind: 'tool', name: 'Skill', summary: `jira: read ${key}` });
    const dir = process.env.AOM_MOCK_SOURCES_DIR ?? '';
    try {
      source = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8')) as MockSource;
      say(`Read Jira ticket ${key} with the Jira skill: ${source.title ?? ''}`);
    } catch {
      say(`I could not read Jira ticket ${key} (no Jira tool is configured on this workstation).`);
      return finish();
    }
  }

  let project = ctx.mappedProjectKey;
  if (!project) {
    const prefix = key && ctx.externalSystem !== 'github' ? key.split('-')[0] : undefined;
    const repoName = key && ctx.externalSystem === 'github' ? key.split('#')[0]?.split('/')[1] : undefined;
    project =
      ctx.projects.find((p) => p.key === prefix)?.key ??
      ctx.projects.find((p) => repoName && p.repos.includes(repoName))?.key ??
      ctx.projects.find((p) => p.key === source.project)?.key ??
      (!key && ctx.projects.length === 1 ? ctx.projects[0]?.key : undefined);
    if (!project) {
      const r = aom([
        'intake',
        'unmapped',
        '--note',
        `mock BA: none of ${ctx.projects.map((p) => p.key).join(', ')} matches ${key ?? 'this request'}`,
      ]);
      say(
        r.code === 0
          ? `I could not map ${key ?? 'this request'} to a project, so I asked you on the desk.`
          : `Could not ask: ${r.err.trim()}`,
      );
      return finish();
    }
    const m = aom(['intake', 'map', '--project', project]);
    if (m.code !== 0) {
      say(`Mapping failed: ${(m.err || m.out).trim()}`);
      return finish();
    }
    say(`Mapped to project ${project}.`);
  }
  if (ctx.cards.length > 0) {
    say(`Cards of this intake: ${ctx.cards.map((c) => `${c.ref} (${c.status})`).join(', ')}.`);
    return finish();
  }

  const repo = ctx.projects.find((p) => p.key === project)?.repos[0];
  const drafts = source.cards ?? [source];
  const refs: string[] = [];
  // Phases: propose (or reuse) the phase first; the cards marked `phase: true` are drafted into it.
  let phaseRef: string | undefined;
  if (source.phase) {
    const args = ['phase', 'propose', '--name', source.phase.name];
    if (source.phase.description) args.push('--description', source.phase.description);
    if (source.phase.followups)
      args.push('--followups-file', tmpJson('followups.json', source.phase.followups));
    const pr = aom(args);
    phaseRef = /\b([A-Z][A-Z0-9]+-P\d+)\b/.exec(pr.out)?.[1];
    if (pr.code !== 0 || !phaseRef) {
      say(`Could not propose the phase: ${(pr.err || pr.out).trim()}`);
      return finish();
    }
    say(`Proposed phase ${phaseRef}: ${source.phase.name}.`);
  }
  for (const d of drafts) {
    const title = d.title ?? source.title ?? 'Untitled';
    const draft = {
      title,
      cardType: 'feature',
      completionAction: d.completionAction ?? source.completionAction ?? 'push_branch',
      docsNeeded: d.docsNeeded ?? false,
      ...((d.repo ?? repo) ? { repo: d.repo ?? repo } : {}),
      ...(key ? { externalRef: key } : {}),
      ...(phaseRef && (d as { phase?: boolean }).phase ? { phase: phaseRef } : {}),
      dependencies: ((d as { dependsOn?: number[] }).dependsOn ?? []).map((i) => refs[i]).filter(Boolean),
      fields: {
        context: `${key ? `${key}: ` : ''}${title}\n\n${d.body ?? source.body ?? ''}`.trim(),
        requirements: d.body ?? source.body ?? title,
        acceptanceCriteria: d.acceptanceCriteria ?? [`Implements: ${title}`],
        affectedAreas: 'src/',
        constraints: 'none',
        testPlan: 'Run the unit tests',
        ...((d.mock ?? source.mock) ? { mock: d.mock ?? source.mock } : {}),
      },
    };
    const c = aom(['card', 'create', '--file', tmpJson('draft.json', draft)]);
    const ref = /Created (\S+) /.exec(c.out)?.[1];
    if (c.code !== 0 || !ref) {
      say(`Could not create "${title}": ${(c.err || c.out).trim()}`);
      return finish();
    }
    refs.push(ref);
  }
  for (const ref of refs) {
    const s = aom(['card', 'specify', ref]);
    say(s.code === 0 ? s.out.trim() : `Could not specify ${ref}: ${(s.err || s.out).trim()}`);
  }
  if (phaseRef) {
    const sub = aom(['phase', 'submit', phaseRef]);
    say(
      sub.code === 0
        ? `Asked you to confirm ${phaseRef} on the desk.`
        : `Could not submit ${phaseRef}: ${(sub.err || sub.out).trim()}`,
    );
  }
  say(`Created ${refs.join(', ')} from ${key ?? 'your request'}.`);
  return finish();
}

interface MockDesign {
  departments?: string[];
  roles?: unknown[];
  workflows?: unknown[];
}

/**
 * The BA's design chat (M10), scripted: `design { "departments": [...], "roles": [...], "workflows": [...] }` is "the
 * need described to the BA". It drafts every definition with the real `aom org` verbs, validates, submits what is
 * valid (roles first) and reports what is wrong with the rest; a message without a definition gets a question back.
 */
async function designMain(): Promise<number> {
  const message = process.env.AOM_MOCK_MESSAGE ?? '';
  const said: string[] = [];
  const say = (text: string) => {
    said.push(text);
    emit({ kind: 'delta', text: `${text}\n` });
  };
  emit({ kind: 'session', runtimeSessionId: process.env.AOM_MOCK_SESSION ?? 'mock-design' });
  emit({ kind: 'usage', usage: { inputTokens: message.length, outputTokens: 120 } });
  const finish = (): number => {
    emit({ kind: 'final', text: said.join('\n') });
    return 0;
  };
  let spec: MockDesign | undefined;
  try {
    spec = JSON.parse(message.replace(/^\s*design\b/i, '').trim()) as MockDesign;
  } catch {
    spec = undefined;
  }
  if (!spec || (!spec.roles?.length && !spec.workflows?.length && !spec.departments?.length)) {
    say(
      'Before I draft anything: which stages should the workflow have, which role claims each stage, what must be known before a stage starts, and where does a failure go?',
    );
    return finish();
  }
  const run = (args: string[]): { ok: boolean; text: string } => {
    const r = aom(args);
    return { ok: r.code === 0, text: (r.code === 0 ? r.out : r.err || r.out).trim() };
  };
  for (const name of spec.departments ?? []) say(run(['org', 'department', '--name', name]).text);
  const keys: Array<{ key: string; kind: 'role' | 'workflow' }> = [];
  for (const [kind, list] of [
    ['role', spec.roles ?? []],
    ['workflow', spec.workflows ?? []],
  ] as const) {
    for (const def of list as Array<{ key: string }>) {
      const r = run(['org', kind, 'draft', '--file', tmpJson(`${kind}.json`, def)]);
      say(r.text);
      if (r.ok) keys.push({ key: def.key, kind });
    }
  }
  for (const { key, kind } of keys) {
    const v = run(['org', 'validate', key, `--${kind}`]);
    if (!v.ok || !v.text.startsWith('Valid.')) {
      say(`${key} is not valid yet, so I did not submit it: ${v.text}`);
      continue;
    }
    const s = run(['org', 'submit', key, `--${kind}`]);
    say(s.ok ? `Submitted ${kind} ${key} for your approval.` : `Could not submit ${key}: ${s.text}`);
  }
  return finish();
}

/**
 * The BA in a chat that is not an intake, scripted: `create card [KEY:] <title>` maps the project (unless the chat has
 * one in context), creates a card with the draft passed inline (`--json`) and specifies it.
 */
async function deskMain(): Promise<number> {
  const message = process.env.AOM_MOCK_MESSAGE ?? '';
  const raw = JSON.parse(process.env.AOM_MOCK_CONTEXT ?? '{}') as {
    projectKey?: string;
    intake?: { mappedProjectKey?: string };
  };
  const ctx = { projectKey: raw.projectKey ?? raw.intake?.mappedProjectKey };
  const said: string[] = [];
  const say = (text: string) => {
    said.push(text);
    emit({ kind: 'delta', text: `${text}\n` });
  };
  emit({ kind: 'session', runtimeSessionId: process.env.AOM_MOCK_SESSION ?? 'mock-desk' });
  emit({ kind: 'usage', usage: { inputTokens: message.length, outputTokens: 120 } });
  const finish = (): number => {
    emit({ kind: 'final', text: said.join('\n') });
    return 0;
  };
  const rq = /^\s*request repo\s+(\S+)\s+(\S+)(?:\s+(public|private))?/i.exec(message);
  if (rq) {
    const r = aom([
      'repo',
      'create',
      '--name',
      rq[1] as string,
      '--project',
      rq[2] as string,
      rq[3]?.toLowerCase() === 'public' ? '--public' : '--private',
      '--description',
      'Created by the mock BA',
    ]);
    say(r.code === 0 ? r.out.trim() : `Could not request the repository: ${(r.err || r.out).trim()}`);
    return finish();
  }
  const m = /^\s*create card\s+(?:([A-Za-z0-9]+):\s*)?(.+)$/is.exec(message);
  const repoName = /\brepo=(\S+)/.exec(message)?.[1];
  const title = m?.[2]
    ?.replace(/\brepo=\S+/, '')
    .trim()
    .slice(0, 80);
  const key = m?.[1] ?? ctx.projectKey;
  if (!title) {
    say('Tell me the card: `create card <KEY>: <title>`.');
    return finish();
  }
  if (key && !ctx.projectKey) {
    const r = aom(['intake', 'map', '--project', key]);
    if (r.code !== 0) {
      say(`Mapping failed: ${(r.err || r.out).trim()}`);
      return finish();
    }
  }
  const draft = {
    title,
    cardType: 'feature',
    completionAction: 'push_branch',
    docsNeeded: false,
    ...(repoName ? { repo: repoName } : {}),
    fields: {
      context: title,
      requirements: title,
      acceptanceCriteria: [`Implements: ${title}`],
      affectedAreas: 'src/',
      constraints: 'none',
      testPlan: 'Run the unit tests',
    },
  };
  const c = aom(['card', 'create', '--json', JSON.stringify(draft)]);
  const ref = /Created (\S+) /.exec(c.out)?.[1];
  if (c.code !== 0 || !ref) {
    say(`Could not create "${title}": ${(c.err || c.out).trim()}`);
    return finish();
  }
  const s = aom(['card', 'specify', ref]);
  say(s.code === 0 ? s.out.trim() : `Could not specify ${ref}: ${(s.err || s.out).trim()}`);
  say(`Created ${ref} from this chat.`);
  return finish();
}

async function main(): Promise<number> {
  if (process.env.AOM_MOCK_CHAT === 'desk') return deskMain();
  if (process.env.AOM_MOCK_CHAT === 'intake') return intakeMain();
  if (process.env.AOM_MOCK_CHAT === 'design') return designMain();
  const card = aom(['card', '--json']);
  if (card.code !== 0) {
    process.stderr.write(`aom card failed: ${card.err}\n`);
    return 1;
  }
  const brief = JSON.parse(card.out) as Brief;
  if ((brief.shift as { kind?: string }).kind === 'devops') return devopsMain(brief as DevopsBrief);
  if (brief.shift.kind === 'question') return questionMain(brief);
  if ((brief.shift as { kind?: string }).kind === 'ba_task') return baTaskMain(brief as BaTaskBrief);
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
