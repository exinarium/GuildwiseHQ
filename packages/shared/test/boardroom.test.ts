import { describe, expect, it } from 'vitest';
import {
  assembleMinutes,
  BOARD_END_OPTION_LABEL,
  BOARD_SPEAKERS_MAX,
  BOARD_TURN_MAX_CHARS,
  BoardConfigSchema,
  BoardSettingsSchema,
  buildCastTurn,
  buildChairTurn,
  buildMinutesTurn,
  buildSpeakerTurn,
  CreateBoardRequestSchema,
  capTurnText,
  chooseSpeakers,
  DomainEventSchema,
  estimateNextRound,
  handlesOf,
  hatFor,
  PatchBoardRequestSchema,
  parseBoardConfig,
  parseMentions,
  parsePosition,
  participantSlug,
  resolveHandle,
  roundAssignment,
  seedPrdFromMinutes,
  sideFor,
} from '../src/index.ts';

const ID = (n: number) => `0192f3a0-0000-7000-8000-00000000000${n}`;

describe('board config', () => {
  it('fills defaults and never throws on a malformed key', () => {
    const c = parseBoardConfig({});
    expect(c).toMatchObject({
      stage: 'setup',
      round: 0,
      roundCap: null,
      format: 'open',
      paused: false,
      mentions: [],
    });
    const bad = parseBoardConfig({ round: 'x', format: 'open', roundCap: 99, stage: 'round' });
    expect(bad).toMatchObject({ round: 0, roundCap: null, stage: 'round', format: 'open' });
    expect(() => BoardConfigSchema.parse({ stage: 'nope' })).toThrow();
  });

  it('has no round cap by default; a session made with a cap keeps it (1 to 50)', () => {
    expect(parseBoardConfig({}).roundCap).toBeNull();
    expect(parseBoardConfig({ roundCap: 4 }).roundCap).toBe(4);
    expect(parseBoardConfig({ roundCap: 12 }).roundCap).toBe(12);
    expect(parseBoardConfig({ roundCap: 50 }).roundCap).toBe(50);
    expect(parseBoardConfig({ roundCap: 0 }).roundCap).toBeNull();
    const s = BoardSettingsSchema.parse({});
    expect(s.roundCap).toBeNull();
    expect(BoardSettingsSchema.parse({ roundCap: null }).roundCap).toBeNull();
    expect(BoardSettingsSchema.safeParse({ roundCap: 51 }).success).toBe(false);
    expect(PatchBoardRequestSchema.parse({ roundCap: null }).roundCap).toBeNull();
  });

  it('needs two to eight seats, an agent by id and a persona by key', () => {
    const ok = {
      topic: 't',
      cast: [
        { kind: 'persona', refId: 'cost-hawk' },
        { kind: 'persona', refId: 'ad-hoc-regulator', stance: 'x' },
      ],
    };
    expect(CreateBoardRequestSchema.safeParse(ok).success).toBe(true);
    expect(
      CreateBoardRequestSchema.safeParse({ topic: 't', cast: [{ kind: 'persona', refId: 'cost-hawk' }] })
        .success,
    ).toBe(false);
    expect(
      CreateBoardRequestSchema.safeParse({
        topic: 't',
        cast: [
          { kind: 'agent', refId: 'not-a-uuid' },
          { kind: 'persona', refId: 'a' },
        ],
      }).success,
    ).toBe(false);
    expect(
      CreateBoardRequestSchema.safeParse({
        topic: 't',
        cast: [
          { kind: 'persona', refId: 'Bad Key' },
          { kind: 'persona', refId: 'a' },
        ],
      }).success,
    ).toBe(false);
  });

  it('knows the board events', () => {
    for (const e of [
      {
        type: 'BoardRoundPlanned',
        payload: {
          threadId: ID(1),
          round: 2,
          kind: 'dissent',
          speakers: [{ participantId: ID(2), name: 'A' }],
          source: 'chair',
        },
      },
      {
        type: 'BoardNoteAdded',
        payload: {
          threadId: ID(1),
          noteId: ID(2),
          column: 'risks',
          text: 't',
          by: { kind: 'persona', id: 'x', name: 'X' },
        },
      },
      { type: 'BoardNoteMerged', payload: { threadId: ID(1), intoNoteId: ID(2), noteIds: [ID(3)] } },
      { type: 'BoardNoteVoted', payload: { threadId: ID(1), noteId: ID(2), userId: ID(3), voted: true } },
      {
        type: 'BoardDecisionRaised',
        payload: { threadId: ID(1), decisionId: ID(2), question: 'q', askedByName: 'Chair' },
      },
      {
        type: 'BoardDisagreementRecorded',
        payload: {
          threadId: ID(1),
          disagreementId: ID(2),
          topic: 't',
          positions: [
            { who: 'a', position: 'x' },
            { who: 'b', position: 'y' },
          ],
          by: { kind: 'persona', id: null, name: 'A' },
        },
      },
    ])
      expect(DomainEventSchema.safeParse(e).success, e.type).toBe(true);
  });
});

describe('names and @mentions', () => {
  const people = [
    {
      id: ID(1),
      displayName: "Devil's Advocate",
      refId: 'devils-advocate',
      seat: 'Panelist',
      kind: 'persona',
    },
    { id: ID(2), displayName: 'Cost Hawk', refId: 'cost-hawk', seat: 'Panelist', kind: 'persona' },
    { id: ID(3), displayName: 'Regulator', refId: 'ad-hoc-regulator', seat: 'Compliance', kind: 'persona' },
  ];
  const mentionables = people.map((p) => ({ id: p.id, handles: handlesOf(p) }));
  const all = people.map((p) => p.id);

  it('slugs a name without its apostrophe', () => {
    expect(participantSlug("Devil's Advocate")).toBe('devils-advocate');
    expect(participantSlug('  Cost   Hawk! ')).toBe('cost-hawk');
    expect(handlesOf(people[2] as never).sort()).toEqual(['compliance', 'regulator']);
    expect(handlesOf(people[1] as never)).toEqual(['cost-hawk']);
  });

  it('finds mentions in order, once each, and @all', () => {
    expect(
      parseMentions('@cost-hawk and @devils-advocate, what about @cost-hawk?', mentionables, all),
    ).toEqual([ID(2), ID(1)]);
    expect(parseMentions('hey @all', mentionables, all)).toEqual(all);
    expect(parseMentions('@compliance please', mentionables, all)).toEqual([ID(3)]);
    expect(parseMentions('mail me at a@cost-hawk.com or @nobody', mentionables, all)).toEqual([]);
    expect(parseMentions('(@regulator)', mentionables, all)).toEqual([ID(3)]);
  });

  it('resolves a --speaker handle by slug, name or id prefix', () => {
    expect(resolveHandle('@cost-hawk', people)).toBe(ID(2));
    expect(resolveHandle("Devil's Advocate", people)).toBe(ID(1));
    expect(resolveHandle('Compliance', people)).toBe(ID(3));
    expect(resolveHandle(ID(2), people)).toBe(ID(2));
    expect(resolveHandle('nobody', people)).toBeNull();
  });
});

describe('who speaks next', () => {
  const cands = [1, 2, 3, 4, 5].map((n) => ({ id: ID(n), spoken: n % 3 }));
  it('never opens with the last speaker, drops duplicates and strangers, and stops at three', () => {
    const r = chooseSpeakers({
      candidates: cands,
      picked: [ID(1), ID(1), ID(2), ID(3), ID(4), ID(5), ID(9)],
      mentions: [],
      lastSpeakerId: ID(1),
    });
    expect(r.speakers).toHaveLength(BOARD_SPEAKERS_MAX);
    expect(r.speakers[0]).not.toBe(ID(1));
    expect(new Set(r.speakers).size).toBe(r.speakers.length);
    expect(r.notes.join(' ')).toMatch(/Duplicates/);
  });

  it('puts mentioned seats first, even the last speaker, and lets them exceed the usual cap only for the mentioned', () => {
    const r = chooseSpeakers({
      candidates: cands,
      picked: [ID(2), ID(3)],
      mentions: [ID(1)],
      lastSpeakerId: ID(1),
    });
    expect(r.speakers[0]).toBe(ID(1));
    expect(r.speakers.length).toBeLessThanOrEqual(BOARD_SPEAKERS_MAX);
    const many = chooseSpeakers({
      candidates: cands,
      picked: [],
      mentions: [ID(1), ID(2), ID(3), ID(4)],
      lastSpeakerId: null,
    });
    expect(many.speakers).toEqual([ID(1), ID(2), ID(3), ID(4)]);
  });

  it('makes its own pick, the least heard first, when the Chair gave none', () => {
    const r = chooseSpeakers({ candidates: cands, picked: [], mentions: [], lastSpeakerId: ID(3) });
    expect(r.speakers).toHaveLength(2);
    expect(r.speakers).not.toContain(ID(3));
    const spoken = (id: string) => cands.find((c) => c.id === id)?.spoken ?? 0;
    expect(spoken(r.speakers[0] as string)).toBeLessThanOrEqual(spoken(r.speakers[1] as string));
  });

  it('never returns the last speaker alone, whatever the pick, and is deterministic', () => {
    for (const last of cands.map((c) => c.id))
      for (const pick of [[last], [], [last, last]]) {
        const a = chooseSpeakers({ candidates: cands, picked: pick, mentions: [], lastSpeakerId: last });
        const b = chooseSpeakers({ candidates: cands, picked: pick, mentions: [], lastSpeakerId: last });
        expect(a).toEqual(b);
        expect(a.speakers[0]).not.toBe(last);
        expect(a.speakers.length).toBeGreaterThan(0);
      }
  });
});

describe('length cap, estimate and formats', () => {
  it('cuts at a sentence and marks the cut; leaves a short text alone', () => {
    expect(capTurnText('Short.')).toEqual({ text: 'Short.', cut: false });
    const long = 'This sentence goes on. '.repeat(100);
    const c = capTurnText(long);
    expect(c.cut).toBe(true);
    expect(c.text.length).toBeLessThanOrEqual(BOARD_TURN_MAX_CHARS + 3);
    expect(c.text.endsWith('…')).toBe(true);
    expect(capTurnText('x'.repeat(5000), 100).text.length).toBeLessThanOrEqual(103);
  });

  it('estimates the next round from the cast size and the average turn', () => {
    expect(
      estimateNextRound({ castSize: 5, nextRound: 1, avgSpeakerTurnUsd: null, avgChairTurnUsd: null }),
    ).toEqual({ speakers: 5, usd: 0.05, basis: 'default' });
    expect(
      estimateNextRound({ castSize: 5, nextRound: 2, avgSpeakerTurnUsd: 0.02, avgChairTurnUsd: 0.01 }),
    ).toEqual({ speakers: 3, usd: 0.07, basis: 'average' });
    expect(
      estimateNextRound({ castSize: 2, nextRound: 3, avgSpeakerTurnUsd: 0.1, avgChairTurnUsd: null })
        .speakers,
    ).toBe(2);
  });

  it('rotates the six hats and swaps the sides in a dissent round', () => {
    const labels = [0, 1, 2, 3, 4, 5].map((i) => hatFor(i, 1).key);
    expect(new Set(labels).size).toBe(6);
    expect(hatFor(0, 2).key).toBe(hatFor(1, 1).key);
    expect(sideFor(0, 'independent')).toBe('red');
    expect(sideFor(0, 'dissent')).toBe('blue');
    expect(roundAssignment('six_hats', { round: 1, kind: 'independent', index: 2 }).label).toBe('Black hat');
    expect(roundAssignment('red_blue', { round: 1, kind: 'independent', index: 1 }).text).toMatch(
      /blue team: defend/,
    );
    expect(roundAssignment('pre_mortem', { round: 1, kind: 'independent', index: 0 }).text).toMatch(
      /a year from now/,
    );
    expect(roundAssignment('option_scoring', { round: 1, kind: 'independent', index: 0 }).text).toMatch(
      /1 \(poor\) to 5/,
    );
    expect(roundAssignment('open', { round: 2, kind: 'dissent', index: 0 }).text).toMatch(/steel-man/i);
  });
});

describe('prompts', () => {
  const person = (n: number, name: string) => ({
    id: ID(n),
    name,
    slug: participantSlug(name),
    seat: 'Panelist',
    stance: `${name} stance`,
    spoken: n,
  });
  it('repeats the stance and the length rule in every speaker turn, and hides the others in the first round', () => {
    const t = buildSpeakerTurn({
      topic: 'Launch?',
      brief: 'Eight weeks',
      format: 'open',
      round: 1,
      roundCap: 3,
      kind: 'independent',
      instruction: '',
      reason: '',
      speaker: { name: 'Cost Hawk', slug: 'cost-hawk', seat: 'Panelist', stance: 'Watches money', index: 0 },
      total: 3,
      decisions: [],
    }).message;
    expect(t).toContain('<!--board:');
    expect(t).toContain('Your stance (hold it, whatever the others say): Watches money');
    expect(t).toContain('at most 150 words');
    expect(t).toContain('You have not seen anyone else yet');
    expect(t).toContain('Eight weeks');
    const later = buildSpeakerTurn({
      topic: 'Launch?',
      brief: '',
      format: 'red_blue',
      round: 2,
      roundCap: 3,
      kind: 'discussion',
      instruction: 'Name the gap',
      reason: 'They differ',
      speaker: { name: 'Cost Hawk', slug: 'cost-hawk', seat: 'Panelist', stance: 'Watches money', index: 1 },
      total: 3,
      decisions: [{ question: 'Pilot?', answer: 'Yes' }],
    }).message;
    expect(later).toContain('The Chair asks: Name the gap');
    expect(later).toContain('blue team');
    expect(later).toContain('Pilot? -> Yes');
    expect(later).not.toContain('You have not seen anyone else yet');
  });

  it('tells the Chair who spoke last, who was mentioned and the verbs, and flags a retry', () => {
    const people = [person(1, 'Cost Hawk'), person(2, 'User Advocate')];
    const t = buildChairTurn({
      topic: 'Launch?',
      brief: '',
      format: 'open',
      round: 1,
      roundCap: 4,
      people,
      lastSpeaker: people[0] ?? null,
      mentions: [people[1] as never],
      dissentNext: true,
      dissentNote: 'all agree',
      notes: [],
      disagreements: [],
      decisions: [],
      retry: true,
    }).message;
    expect(t).toContain('do not pick them first');
    expect(t).toContain('The owner @mentioned User Advocate');
    expect(t).toContain('aom board next');
    expect(t).toContain('aom board pause');
    expect(t).toContain('already flagged convergence');
    expect(t).toContain('Your last turn ended without a valid pick');
    expect(t).toContain('"lastSpeaker":"cost-hawk"');
  });

  it('tells the Chair there is no cap and to propose ending instead of looping', () => {
    const people = [person(1, 'Cost Hawk')];
    const base = {
      topic: 'Launch?',
      brief: '',
      format: 'open' as const,
      round: 3,
      roundCap: null,
      people,
      lastSpeaker: null,
      mentions: [],
      dissentNext: false,
      dissentNote: null,
      notes: [],
      disagreements: [],
      decisions: [],
      retry: false,
    };
    const calm = buildChairTurn(base).message;
    expect(calm).toContain('no round cap');
    expect(calm).not.toContain('at most');
    expect(calm).toContain('End here?');
    expect(calm).toContain(BOARD_END_OPTION_LABEL);
    expect(calm).not.toContain('NOTHING NEW');
    const dry = buildChairTurn({ ...base, quietRounds: 2 }).message;
    expect(dry).toContain('NOTHING NEW');
    expect(dry).toContain('aom board pause --question "End here?"');
    expect(buildChairTurn({ ...base, quietRounds: 1 }).message).not.toContain('NOTHING NEW');
    // a capped room still says so
    expect(buildChairTurn({ ...base, roundCap: 4 }).message).toContain('at most 4');
    const speaker = buildSpeakerTurn({
      topic: 't',
      brief: '',
      format: 'open',
      round: 5,
      roundCap: null,
      kind: 'discussion',
      instruction: '',
      reason: '',
      speaker: { name: 'Cost Hawk', slug: 'cost-hawk', seat: 'Panelist', stance: null, index: 0 },
      total: 3,
      decisions: [],
    }).message;
    expect(speaker).toContain('Round 5:');
    expect(speaker).not.toContain('of at most');
  });

  it('builds the cast and minutes turns', () => {
    const c = buildCastTurn({
      topic: 'Second office?',
      brief: '',
      format: 'open',
      personas: [{ key: 'cost-hawk', name: 'Cost Hawk', description: 'Money' }],
      agents: [{ name: 'Ben', role: 'ba' }],
    }).message;
    expect(c).toContain('aom board cast --persona');
    expect(c).toContain('cost-hawk');
    expect(c).toContain('Ben (ba)');
    const m = buildMinutesTurn({
      topic: 'T',
      format: 'open',
      rounds: 2,
      people: [person(1, 'Cost Hawk')],
      notes: [],
      disagreements: [],
      decisions: [],
      endReason: 'ended by the owner',
    }).message;
    expect(m).toContain('aom board minutes');
    expect(m).toContain('## Open questions');
  });
});

describe('minutes and the PRD seed', () => {
  const base = {
    topic: 'Launch a pilot?',
    format: 'pre_mortem' as const,
    brief: 'Eight weeks',
    startedAt: '2026-10-03T10:00:00.000Z',
    rounds: 3,
    endReason: 'by the owner',
    people: [
      { name: 'Cost Hawk', seat: 'Panelist', kind: 'persona' },
      { name: 'Ben', seat: 'BA', kind: 'agent' },
    ],
    synthesis:
      '## Positions\n\n- Cost Hawk: later\n\n## Agreements\n\n- test first\n\n## Open questions\n\n- unit cost?',
    disagreements: [
      {
        topic: 'Pilot now',
        positions: [
          { who: 'Cost Hawk', position: 'later' },
          { who: 'Ben', position: 'now' },
        ],
      },
    ],
    decisions: [{ question: 'Which way?', answer: 'Prove demand' }],
    notes: [
      { id: ID(1), column: 'risks' as const, text: 'Adoption', byName: 'Cost Hawk', votes: 2 },
      { id: ID(2), column: 'ideas' as const, text: 'Pilot', byName: 'Ben', votes: 0 },
    ],
    costUsd: 0.1234,
  };
  it('writes every required section from the data and the synthesis, deterministically', () => {
    const a = assembleMinutes(base);
    expect(assembleMinutes(base)).toBe(a);
    for (const h of [
      '# Minutes: Launch a pilot?',
      '- Format: Pre-mortem',
      '- Date: 2026-10-03',
      '## Cast',
      '- Ben (BA, agent)',
      '## Positions',
      '## Agreements',
      '## Open questions',
      '## Unresolved disagreements',
      '- **Pilot now**',
      '  - Cost Hawk: later',
      '## Decisions',
      '- Which way? -> Prove demand',
      '## Whiteboard',
      '### Risks',
      '- Adoption (+2)',
      '### Ideas',
      '### Parked',
    ])
      expect(a, h).toContain(h);
    expect(a).toContain('Cost: $0.12');
    expect(assembleMinutes({ ...base, synthesis: '', disagreements: [] })).toContain(
      'The synthesis could not be written',
    );
  });

  it('seeds a PRD from the minutes with the template first', () => {
    const prd = seedPrdFromMinutes({
      title: 'Launch',
      topic: 'Launch a pilot?',
      minutesDocId: ID(5),
      decisions: ['Prove demand'],
      ideas: ['Pilot'],
      risks: ['Adoption'],
      questions: [],
      parked: [],
      template: '# PRD template\n\n## 1. Goals',
    });
    expect(prd.startsWith('# PRD template')).toBe(true);
    expect(prd).toContain('Seeded from the boardroom minutes (document');
    expect(prd).toContain('### Decisions taken in the boardroom');
    expect(prd).toContain('- Prove demand');
    expect(prd).toContain('### Open questions\n\n- (none)');
    expect(
      seedPrdFromMinutes({
        title: 'Launch',
        topic: 't',
        minutesDocId: ID(5),
        decisions: [],
        ideas: [],
        risks: [],
        questions: [],
        parked: [],
        template: '',
      }).startsWith('# PRD: Launch'),
    ).toBe(true);
  });

  it('parses a recorded position', () => {
    expect(parsePosition('Cost Hawk|later, after numbers')).toEqual({
      who: 'Cost Hawk',
      position: 'later, after numbers',
    });
    expect(parsePosition('no bar')).toBeNull();
    expect(parsePosition('|x')).toBeNull();
    expect(parsePosition('a|')).toBeNull();
  });
});
