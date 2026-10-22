import { describe, expect, it } from 'vitest';
import {
  applyDocSection,
  buildCeoAnswerTurn,
  buildFacilitatorTurn,
  buildHandoffNote,
  CreateDiscoveryRequestSchema,
  DISCOVERY_PHASES,
  discoveryElapsedMs,
  discoveryProgress,
  type FacilitatorPromptInput,
  isSessionRpc,
  parseCheckItem,
  parseDiscoveryConfig,
  renderPanel,
  renderQa,
  SessionAskParamsSchema,
  SessionNoteParamsSchema,
  shortId,
} from '../src/index.ts';

const U = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';

describe('discovery config', () => {
  it('fills defaults and survives malformed keys', () => {
    expect(parseDiscoveryConfig({})).toMatchObject({
      stance: 'facilitator',
      phase: 'frame',
      ceoMode: 'owner_only',
      paused: false,
      budgetUsd: null,
      pendingTrigger: null,
    });
    const odd = parseDiscoveryConfig({ phase: 'nope', stance: 'partner', budgetUsd: -4, timeBoxMinutes: 30 });
    expect(odd).toMatchObject({ phase: 'frame', stance: 'partner', budgetUsd: null, timeBoxMinutes: 30 });
    expect(parseDiscoveryConfig(null).phase).toBe('frame');
  });

  it('keeps the clock of a paused session and counts the time box', () => {
    const t0 = new Date('2026-10-01T10:00:00Z');
    const running = { elapsedMs: 5 * 60_000, activeSince: t0.toISOString(), timeBoxMinutes: 30 };
    expect(discoveryElapsedMs(running, new Date(t0.getTime() + 10 * 60_000))).toBe(15 * 60_000);
    const paused = { elapsedMs: 15 * 60_000, activeSince: null, timeBoxMinutes: 30 };
    expect(discoveryElapsedMs(paused, new Date(t0.getTime() + 99 * 3_600_000))).toBe(15 * 60_000);
    expect(discoveryProgress(paused, t0)).toEqual({ elapsedMinutes: 15, remainingMinutes: 15, fraction: 0.5 });
    expect(discoveryProgress({ ...paused, elapsedMs: 40 * 60_000 }, t0)).toMatchObject({
      remainingMinutes: 0,
      fraction: 1,
    });
    expect(discoveryProgress({ ...paused, timeBoxMinutes: null }, t0)).toMatchObject({
      remainingMinutes: null,
      fraction: null,
    });
  });

  it('validates a new session request', () => {
    const r = CreateDiscoveryRequestSchema.parse({ title: 'x' });
    expect(r).toMatchObject({ stance: 'facilitator', ceoMode: 'owner_only', playbook: 'brainstorm', idea: '' });
    expect(CreateDiscoveryRequestSchema.safeParse({ title: 'x', ceoMode: 'always' }).success).toBe(false);
    expect(CreateDiscoveryRequestSchema.safeParse({ title: 'x', timeBoxMinutes: 1 }).success).toBe(false);
  });
});

describe('the aom session verbs', () => {
  it('knows which rpc methods are session verbs', () => {
    expect(isSessionRpc('session.ask')).toBe(true);
    expect(isSessionRpc('session.board')).toBe(false);
    expect(isSessionRpc('ledger.search')).toBe(false);
  });

  it('checks ask and note params', () => {
    expect(SessionAskParamsSchema.parse({ question: 'q' })).toMatchObject({ options: [], allowFreeText: true });
    expect(SessionAskParamsSchema.safeParse({ question: 'q', options: Array(7).fill('x') }).success).toBe(false);
    expect(SessionNoteParamsSchema.safeParse({ op: 'add', section: 'ideas', text: 'x' }).success).toBe(true);
    expect(SessionNoteParamsSchema.safeParse({ op: 'add', section: 'plans', text: 'x' }).success).toBe(false);
    expect(SessionNoteParamsSchema.safeParse({ op: 'remove', id: 'ab' }).success).toBe(false);
  });

  it('parses a checklist item', () => {
    expect(parseCheckItem('Goals have a measure|fail|No target')).toEqual({
      criterion: 'Goals have a measure',
      status: 'fail',
      note: 'No target',
    });
    expect(parseCheckItem('A|PASS|x|y')).toEqual({ criterion: 'A', status: 'pass', note: 'x|y' });
    expect(parseCheckItem('A|maybe|x')).toBeNull();
    expect(parseCheckItem('|pass|x')).toBeNull();
  });
});

const input = (over: Partial<FacilitatorPromptInput> = {}): FacilitatorPromptInput => ({
  title: 'Invoicing',
  idea: 'Invoices for freelancers',
  stance: 'facilitator',
  phase: 'frame',
  ceoMode: 'owner_only',
  ceoName: null,
  timeBox: null,
  trigger: { kind: 'start' },
  questions: [],
  notes: [],
  proposals: [],
  docs: [],
  playbook: null,
  draftKind: 'prd',
  ceoPrep: null,
  persona: 'You are the Analyst.',
  ...over,
});
const header = (message: string) => JSON.parse(/<!--discovery:(\{.*?\})-->/.exec(message)?.[1] ?? '{}');

describe('the facilitator turn', () => {
  it('puts the persona and the protocol in the instructions and the situation in the message', () => {
    const t = buildFacilitatorTurn(input());
    expect(t.instructions).toContain('You are the Analyst.');
    for (const verb of ['session ask', 'session note add', 'session propose', 'session phase', 'session draft', 'session validate'])
      expect(t.instructions).toContain(`aom ${verb}`);
    expect(t.instructions).toContain('no pipes, redirects');
    expect(t.message).toContain('The session has just started');
    expect(t.message).toContain('Starting idea: Invoices for freelancers');
    expect(t.message).toContain('Phase: Frame (1 of 5)');
    expect(header(t.message)).toMatchObject({ role: 'facilitator', trigger: 'start', phase: 'frame', asked: 0, openQuestion: false });
  });

  it('shows the question log, the panel with short ids, proposals and the playbook', () => {
    const t = buildFacilitatorTurn(
      input({
        phase: 'capture',
        stance: 'ideate_for_me',
        trigger: { kind: 'answer', detail: 'Answer to "Who?": Agencies.' },
        questions: [
          { id: '1', question: 'Who is it for?', status: 'answered', phase: 'frame', options: [{ id: 'o1', label: 'Freelancers' }], answer: { kind: 'pick', optionId: 'o1', text: null, source: 'owner' }, proposed: null },
          { id: '2', question: 'Pricing?', status: 'proposed', phase: 'frame', options: [], answer: null, proposed: { text: 'Paid', optionId: null, byName: 'Ada' } },
          { id: '3', question: 'Launch?', status: 'open', phase: 'converge', options: [], answer: null, proposed: { text: 'Q1', optionId: null, byName: 'Ada' } },
          { id: '4', question: 'Skipped one', status: 'skipped', phase: 'frame', options: [], answer: { kind: 'skip', optionId: null, text: null, source: 'owner' }, proposed: null },
          { id: '5', question: 'Withdrawn one', status: 'withdrawn', phase: 'frame', options: [], answer: null, proposed: null },
        ],
        notes: [{ id: U, section: 'ideas', text: 'Recurring invoices', byName: 'Analyst' }],
        proposals: [
          { title: 'Add reminders', status: 'applied', resolutionText: null },
          { title: 'Pivot', status: 'redirected', resolutionText: 'No pivot' },
          { title: 'Open one', status: 'open', resolutionText: null },
        ],
        docs: [{ id: U, kind: 'prd', status: 'draft', version: 2 }],
        playbook: {
          key: 'prd',
          body: 'PRD playbook body',
          steps: [{ path: 'steps/step-01-gather.md', text: 'Gather the facts' }],
          assets: [{ path: 'assets/prd-template.md', text: '# Template' }],
        },
      }),
    );
    expect(t.message).toContain('Answer to "Who?": Agencies.');
    expect(t.message).toContain('[frame] Who is it for? -> Freelancers');
    expect(t.message).toContain("CEO's provisional answer (not yet reviewed by the owner): Paid");
    expect(t.message).toContain('OPEN: Launch? (CEO proposes: Q1)');
    expect(t.message).toContain('Skipped one -> skipped');
    expect(t.message).not.toContain('Withdrawn one');
    expect(t.message).toContain(`[${shortId(U)}] Recurring invoices (Analyst)`);
    expect(t.message).toContain('Add reminders: applied');
    expect(t.message).toContain('Pivot: redirected ("No pivot")');
    expect(t.message).toContain('You have a proposal waiting');
    expect(t.message).toContain('prd 019e3f6a-7b1c-7a2d-8c3e-0123456789a1 (version 2, draft)');
    expect(t.message).toContain('The document to write is the PRD');
    expect(t.message).toContain('Stance: ideate for me');
    expect(t.message).toContain('PRD playbook body');
    expect(t.message).toContain('Gather the facts');
    expect(t.message).toContain('# Template');
    expect(header(t.message)).toMatchObject({ openQuestion: true, asked: 4, answered: 3, openProposals: 1, hasPrd: true, hasBrief: false });
  });

  it('describes the CEO mode and the time box', () => {
    const joint = buildFacilitatorTurn(input({ ceoMode: 'joint', ceoName: 'Ada', timeBox: { elapsedMinutes: 10, remainingMinutes: 20 } }));
    expect(joint.message).toContain('Ada takes part');
    expect(joint.message).toContain('proposals, never decisions');
    expect(joint.message).toContain('10 minutes used, 20 left');
    const prep = buildFacilitatorTurn(input({ ceoMode: 'ceo_prep', ceoName: 'Ada', ceoPrep: { state: 'running', turns: 3, cap: 12 }, timeBox: { elapsedMinutes: 40, remainingMinutes: 0 } }));
    expect(prep.message).toContain('3 of 12 turns used');
    expect(prep.message).toContain('Time box used up');
    expect(header(prep.message).timeUp).toBe(true);
  });

  it('has a sentence for every trigger and every phase', () => {
    for (const kind of ['start', 'answer', 'message', 'proposal', 'resume', 'phase_override', 'ceo_answered', 'review_done', 'draft', 'validate'] as const) {
      const trigger = ['message', 'proposal', 'phase_override', 'draft', 'validate'].includes(kind)
        ? ({ kind, detail: 'D' } as never)
        : ({ kind } as never);
      const t = buildFacilitatorTurn(input({ trigger }));
      expect(header(t.message).trigger).toBe(kind);
      expect(t.message.split('\n\n')[1]?.length).toBeGreaterThan(20);
    }
    for (const phase of DISCOVERY_PHASES) expect(buildFacilitatorTurn(input({ phase })).message).toContain('Phase:');
  });

  it('renders an empty panel and log', () => {
    expect(renderPanel([])).toContain('### Parked\n- (none yet)');
    expect(renderQa([])).toBe('- (no questions asked yet)');
  });
});

describe('the CEO turn', () => {
  it('asks for a labelled proposal through one command and shows the question and its options', () => {
    const t = buildCeoAnswerTurn({
      ceoName: 'Ada',
      title: 'Invoicing',
      idea: 'Invoices',
      phase: 'frame',
      mode: 'joint',
      question: { id: 'q9', question: 'Who is it for?', why: 'scope', options: [{ id: 'o1', label: 'Freelancers' }, { id: 'o2', label: 'Agencies' }], allowFreeText: true },
      questions: [],
      notes: [],
      persona: '',
    });
    expect(t.instructions).toContain('PROPOSE');
    expect(t.instructions).toContain('you never decide for them');
    expect(t.instructions).toContain('aom session answer');
    expect(t.message).toContain('- o1: Freelancers');
    expect(t.message).toContain('The facilitator asks because: scope');
    expect(header(t.message)).toEqual({ role: 'ceo_answer', questionId: 'q9', options: ['o1', 'o2'], mode: 'joint', phase: 'frame' });
  });
});

describe('applying a proposal to a document', () => {
  const doc = '# PRD\n\n## 1. Goals\n\nOld goals.\n\n### Detail\n\nsub text\n\n## Scope\n\nAll.\n';
  it('replaces the body of the matching section, with its subsections, and keeps the rest', () => {
    const out = applyDocSection(doc, 'Goals', 'New goals.');
    expect(out).toContain('## 1. Goals\n\nNew goals.\n');
    expect(out).not.toContain('Old goals');
    expect(out).not.toContain('sub text');
    expect(out).toContain('## Scope\n\nAll.');
    expect(applyDocSection(doc, '## goals', 'X')).toContain('## 1. Goals\n\nX');
  });
  it('appends a missing section or the bare change', () => {
    expect(applyDocSection(doc, 'Risks', 'R1')).toMatch(/## Risks\n\nR1\n$/);
    expect(applyDocSection(doc, undefined, 'Extra')).toMatch(/All\.\n\nExtra\n$/);
    expect(applyDocSection('', 'Goals', 'G')).toBe('\n\n## Goals\n\nG\n'.replace(/^\n+/, '\n\n'));
  });
  it('does not treat a heading inside a code block as a section', () => {
    const d = '# T\n\n```\n## Goals\n```\n\n## Goals\n\nreal\n';
    expect(applyDocSection(d, 'Goals', 'new')).toContain('```\n## Goals\n```');
    expect(applyDocSection(d, 'Goals', 'new')).toMatch(/## Goals\n\nnew\n$/);
  });
});

describe('the hand-off note', () => {
  it('carries the PRD and cuts a very long one', () => {
    const n = buildHandoffNote({ title: 'PRD: X', docId: U, version: 3, content: 'a'.repeat(50), max: 100 });
    expect(n).toContain(`document ${U}, version 3`);
    expect(n).toContain('a'.repeat(50));
    const cut = buildHandoffNote({ title: 'PRD: X', docId: U, version: 3, content: 'b'.repeat(500), max: 100 });
    expect(cut).toContain('b'.repeat(100));
    expect(cut).not.toContain('b'.repeat(101));
    expect(cut).toContain('the PRD continues');
  });
});
