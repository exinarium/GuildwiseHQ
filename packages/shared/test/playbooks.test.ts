import { describe, expect, it } from 'vitest';
import {
  applyPlaybookStep,
  buildFacilitatorTurn,
  builtinCapabilities,
  chatToolsFor,
  DISCOVERY_PURPOSE_VERBS,
  filterSlashCommands,
  isTemplateTagged,
  PlaybookRunParamsSchema,
  type PlaybookRunState,
  playbookChatInstruction,
  playbookSteps,
  sessionToolsFor,
  skillChatInstruction,
  slashQueryOf,
  stepLabel,
  stepTitleOf,
} from '../src/index.ts';

const run = (over: Partial<PlaybookRunState> = {}): PlaybookRunState => ({
  key: 'prd',
  name: 'PRD',
  steps: ['Gather', 'Goals and users', 'Requirements'],
  step: null,
  stepTitle: null,
  total: 3,
  startedBy: { kind: 'user', agentId: null, agentName: null },
  ...over,
});

describe('playbook step model', () => {
  it('reads step titles from the headings of a built-in playbook, in order', () => {
    const pb = builtinCapabilities().find((c) => c.kind === 'playbook' && c.key === 'brainstorm');
    expect(pb?.kind).toBe('playbook');
    if (pb?.kind !== 'playbook') return;
    const steps = playbookSteps(pb.steps, pb.files);
    expect(steps.map((s) => s.index)).toEqual([1, 2, 3, 4]);
    expect(steps.map((s) => s.title)).toEqual(['Set up', 'Diverge', 'Converge', 'Capture']);
  });

  it('falls back to the file name when a step has no heading', () => {
    expect(stepTitleOf('steps/step-03-create-epics.md', 'no heading here')).toBe('create epics');
    expect(stepTitleOf('steps/step-01-x.md', '# Step 1: Validate prerequisites')).toBe(
      'Validate prerequisites',
    );
  });

  it('tracks the current step and keeps the known titles', () => {
    const a = applyPlaybookStep(run(), { step: 2 });
    expect(a.ok && a.state.step).toBe(2);
    expect(a.ok && a.state.stepTitle).toBe('Goals and users');
    expect(stepLabel((a as { state: PlaybookRunState }).state)).toBe('Step 2 of 3: Goals and users');
  });

  it('learns titles and the total of an external playbook from what the facilitator reports', () => {
    const empty = run({ steps: [], total: null });
    const a = applyPlaybookStep(empty, { step: 1, title: 'Validate prerequisites', total: 4 });
    expect(a.ok && a.state).toMatchObject({ step: 1, stepTitle: 'Validate prerequisites', total: 4 });
    const b = applyPlaybookStep((a as { state: PlaybookRunState }).state, { step: 2, title: 'Design epics' });
    expect(b.ok && b.state.steps).toEqual(['Validate prerequisites', 'Design epics']);
  });

  it('refuses a step beyond the total', () => {
    const r = applyPlaybookStep(run(), { step: 4 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/3 steps/);
  });
});

describe('the / list', () => {
  const items = [
    {
      kind: 'playbook' as const,
      key: 'prd',
      name: 'PRD',
      description: 'Write a product requirements document',
    },
    {
      kind: 'playbook' as const,
      key: 'bmad:create-epics-and-stories',
      name: 'Create Epics and Stories',
      description: 'Break a PRD into epics',
    },
    {
      kind: 'skill' as const,
      key: 'interview-techniques',
      name: 'Interview techniques',
      description: 'How to interview a PRD owner',
    },
  ];
  it('finds by key, name and description, best match first', () => {
    // the key match first, then the descriptions that mention it
    expect(filterSlashCommands(items, 'prd').map((i) => i.key)).toEqual([
      'prd',
      'bmad:create-epics-and-stories',
      'interview-techniques',
    ]);
    expect(filterSlashCommands(items, 'epics').map((i) => i.key)[0]).toBe('bmad:create-epics-and-stories');
    expect(filterSlashCommands(items, 'create-epics').map((i) => i.key)).toEqual([
      'bmad:create-epics-and-stories',
    ]);
    expect(filterSlashCommands(items, '').length).toBe(3);
    expect(filterSlashCommands(items, 'zzz')).toEqual([]);
  });
  it('knows when the text is a command being typed', () => {
    expect(slashQueryOf('/pr')).toBe('pr');
    expect(slashQueryOf('/')).toBe('');
    expect(slashQueryOf('hello /pr')).toBeNull();
    expect(slashQueryOf('/pr d')).toBeNull();
  });
  it('does not offer templates as commands', () => {
    expect(isTemplateTagged(['template:prd'])).toBe(true);
    expect(isTemplateTagged(['discovery'])).toBe(false);
  });
});

describe('what goes into the chat', () => {
  it('a playbook becomes an instruction that loads it from the registry and fences it as guidance', () => {
    const t = playbookChatInstruction({
      key: 'bmad:create-epics-and-stories',
      name: 'Create Epics',
      input: 'for the billing PRD',
    });
    expect(t).toContain('aom skill show playbook:bmad:create-epics-and-stories');
    expect(t).toContain('one step at a time');
    expect(t).toContain('for the billing PRD');
    expect(playbookChatInstruction({ key: 'prd', name: 'PRD' })).toContain('asking what I want');
  });
  it('a skill becomes an instruction to use it', () => {
    expect(skillChatInstruction({ key: 'interview-techniques', name: 'Interview' })).toContain(
      'skill:interview-techniques',
    );
  });
});

describe('the verbs', () => {
  it('only the facilitator reports a step', () => {
    expect(DISCOVERY_PURPOSE_VERBS.facilitator).toContain('step');
    expect(DISCOVERY_PURPOSE_VERBS.ceo_answer).not.toContain('step');
    expect(sessionToolsFor('facilitator').some((t) => t.name === 'session_step')).toBe(true);
    expect(sessionToolsFor('ceo_answer').some((t) => t.name === 'session_step')).toBe(false);
  });
  it('playbook_run is offered to a chat only with a grant', () => {
    expect(chatToolsFor().some((t) => t.name === 'playbook_run')).toBe(false);
    expect(chatToolsFor({ playbook: true }).some((t) => t.name === 'playbook_run')).toBe(true);
    expect(sessionToolsFor('facilitator').some((t) => t.name === 'playbook_run')).toBe(false);
  });
  it('the run parameters', () => {
    expect(PlaybookRunParamsSchema.safeParse({ key: 'prd' }).success).toBe(true);
    expect(PlaybookRunParamsSchema.safeParse({ key: '' }).success).toBe(false);
    expect(PlaybookRunParamsSchema.safeParse({ key: 'prd', input: 'x'.repeat(5000) }).success).toBe(false);
  });
});

describe('the facilitator prompt of a playbook session', () => {
  const base = {
    title: 'Epics',
    idea: 'for billing',
    stance: 'facilitator' as const,
    phase: 'frame' as const,
    ceoMode: 'owner_only' as const,
    ceoName: null,
    timeBox: null,
    trigger: { kind: 'start' as const },
    questions: [],
    notes: [],
    proposals: [],
    docs: [],
    playbook: null,
    draftKind: 'prd' as const,
    ceoPrep: null,
    persona: 'You are the analyst.',
  };
  it('tells the facilitator to report steps, and says who started it', () => {
    const r = buildFacilitatorTurn({
      ...base,
      playbookRun: {
        ...run({
          startedBy: { kind: 'agent', agentId: '6c9f0f4e-2b2b-4a50-9a0e-0d4f2b9a1c11', agentName: 'Bea' },
          steps: [],
          total: null,
        }),
        input: 'billing epics',
      },
    });
    expect(r.instructions).toContain('aom session step');
    expect(r.message).toContain('The agent Bea started this session');
    expect(r.message).toContain('begin step 1');
    expect(r.message).toContain('billing epics');
  });
  it('without a playbook run there is no step verb', () => {
    const r = buildFacilitatorTurn(base);
    expect(r.instructions).not.toContain('aom session step');
  });
  it('the current step is shown', () => {
    const r = buildFacilitatorTurn({
      ...base,
      playbookRun: { ...run({ step: 2, stepTitle: 'Goals and users' }), input: '' },
    });
    expect(r.message).toContain('You are on Step 2 of 3: Goals and users');
  });
});
