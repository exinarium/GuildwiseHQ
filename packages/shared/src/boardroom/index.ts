import { z } from 'zod';
import { SessionCostSchema } from '../discovery/index.ts';
import { ModelChoiceSchema } from '../models/choices.ts';
import { ParticipantKindSchema, SessionTurnDtoSchema } from '../sessions/index.ts';

/**
 * Boardroom (docs/design/discovery-boardroom-registry.md, phase C): a group conversation between the owner, a cast of
 * personas and real agents, run by a Chair. The server owns the state machine (rounds, speaker choice, decision points,
 * budget); the Chair and the speakers drive it with the `aom board ...` verbs.
 */

/** Runner capability: the runner lets a session turn call the `board.*` rpc methods (an older runner only talks). */
export const BOARD_VERBS_CAPABILITY = 'board-verbs:1';

export const BOARD_FORMATS = ['open', 'pre_mortem', 'red_blue', 'six_hats', 'option_scoring'] as const;
export const BoardFormatSchema = z.enum(BOARD_FORMATS);
export type BoardFormat = z.infer<typeof BoardFormatSchema>;
export const BOARD_FORMAT_LABEL: Record<BoardFormat, string> = {
  open: 'Open discussion',
  pre_mortem: 'Pre-mortem',
  red_blue: 'Red / blue team',
  six_hats: 'Six hats',
  option_scoring: 'Option scoring',
};
export const BOARD_FORMAT_HINT: Record<BoardFormat, string> = {
  open: 'Everyone speaks from their own stance.',
  pre_mortem: 'It is a year later and this failed: why?',
  red_blue: 'Red team attacks, blue team defends.',
  six_hats: 'Each seat wears a thinking hat, rotating by round.',
  option_scoring: 'Score the options you list in the brief, then vote.',
};

export const BOARD_COLUMNS = ['ideas', 'risks', 'questions', 'decisions', 'parked'] as const;
export const StickyColumnSchema = z.enum(BOARD_COLUMNS);
export type StickyColumn = z.infer<typeof StickyColumnSchema>;
export const BOARD_COLUMN_LABEL: Record<StickyColumn, string> = {
  ideas: 'Ideas',
  risks: 'Risks',
  questions: 'Questions',
  decisions: 'Decisions',
  parked: 'Parked',
};

export const BOARD_STAGES = ['setup', 'round', 'chair', 'decision', 'minutes', 'ended'] as const;
export const BoardStageSchema = z.enum(BOARD_STAGES);
export type BoardStage = z.infer<typeof BoardStageSchema>;

export const BOARD_ROUND_KINDS = ['independent', 'discussion', 'dissent'] as const;
export const BoardRoundKindSchema = z.enum(BOARD_ROUND_KINDS);
export type BoardRoundKind = z.infer<typeof BoardRoundKindSchema>;

/** Seats of the room that are not part of the cast. */
export const CHAIR_SEAT = 'Chair';
export const CAST_SEAT_DEFAULT = 'Panelist';

export const BOARD_CAST_MIN = 2;
export const BOARD_CAST_MAX = 8;
export const BOARD_ROUND_CAP_DEFAULT = 4;
export const BOARD_ROUND_CAP_MAX = 12;
/** The Chair picks two or three speakers per discussion round. */
export const BOARD_SPEAKERS_MIN = 1;
export const BOARD_SPEAKERS_MAX = 3;
/** A speaker is asked to stay under this many words; the server cuts a longer reply at the character limit. */
export const BOARD_TURN_MAX_WORDS = 150;
export const BOARD_TURN_MAX_CHARS = 1400;
/** Sticky notes one speaker may add in one turn. */
export const BOARD_NOTES_PER_TURN = 2;
/** When there is no turn to average yet, a persona turn is assumed to cost this much (USD) for the estimate. */
export const BOARD_DEFAULT_TURN_USD = 0.01;

export const BoardModelsSchema = z.object({
  persona: ModelChoiceSchema.optional(),
  chair: ModelChoiceSchema.optional(),
  synthesis: ModelChoiceSchema.optional(),
});
export type BoardModels = z.infer<typeof BoardModelsSchema>;

/**
 * What the models are when the owner chose nothing: cheap for personas, a little more for the Chair, the strongest for the
 * minutes. Each is a generic `{runtime, model}` so another runtime (phase D) plugs in without changing this module.
 */
export const DEFAULT_BOARD_MODELS: Required<BoardModels> = {
  persona: { runtime: 'claude-code', model: 'haiku' },
  chair: { runtime: 'claude-code', model: 'sonnet' },
  synthesis: { runtime: 'claude-code', model: 'opus' },
};

export const BoardPlanSchema = z.object({
  round: z.number().int().min(1),
  kind: BoardRoundKindSchema,
  /** Participant ids, in speaking order. */
  speakers: z.array(z.uuid()).min(1).max(BOARD_CAST_MAX),
  reason: z.string().max(600).default(''),
  instruction: z.string().max(1000).default(''),
  source: z.enum(['independent', 'chair', 'fallback']),
});
export type BoardPlan = z.infer<typeof BoardPlanSchema>;

export const BoardSuggestionSchema = z.object({
  id: z.string().min(1).max(40),
  /** `persona`: a registry persona (`personaKey`). `adhoc`: cast from a one-line brief. */
  type: z.enum(['persona', 'adhoc']),
  personaKey: z.string().max(80).optional(),
  name: z.string().min(1).max(100),
  seat: z.string().min(1).max(60).optional(),
  brief: z.string().max(500).optional(),
  why: z.string().max(400).default(''),
});
export type BoardSuggestion = z.infer<typeof BoardSuggestionSchema>;

/** The session state kept in `threads.session_config` (merged key by key; `null` removes a key). */
export const BoardConfigSchema = z.object({
  board: z.literal(true).default(true),
  topic: z.string().max(2000).default(''),
  /** The owner's brief (context, options, constraints). */
  brief: z.string().max(8000).default(''),
  format: BoardFormatSchema.default('open'),
  roundCap: z.number().int().min(1).max(BOARD_ROUND_CAP_MAX).default(BOARD_ROUND_CAP_DEFAULT),
  budgetUsd: z.number().positive().max(100_000).nullable().default(null),
  budgetStopped: z.boolean().default(false),
  models: BoardModelsSchema.default({}),
  /** A model per cast member, keyed `kind:refId`. */
  castModels: z.record(z.string(), ModelChoiceSchema).default({}),
  stage: BoardStageSchema.default('setup'),
  /** The round in progress, or the last one played. */
  round: z.number().int().nonnegative().default(0),
  plan: BoardPlanSchema.nullable().default(null),
  /** The highest round whose answers the owner can see (round 1 is sealed until every answer is in). */
  revealedRound: z.number().int().nonnegative().default(0),
  paused: z.boolean().default(false),
  /** Participants the owner @mentioned since the last Chair pick: they speak next. */
  mentions: z.array(z.uuid()).default([]),
  /** The Chair saw the room agree too early: the next round is a steel-man/dissent round. */
  dissentNext: z.boolean().default(false),
  dissentNote: z.string().max(600).nullable().default(null),
  briefMessageId: z.uuid().nullable().default(null),
  endReason: z.enum(['owner', 'round_cap']).nullable().default(null),
  /** Chair turns in a row that ended without a valid pick (after two the server picks). */
  chairFailures: z.number().int().nonnegative().default(0),
  /** Why the last attempt to start a turn was refused (budget, paused project); the page shows it, the sweep retries. */
  blocked: z.string().max(60).nullable().default(null),
  /** The synthesis turn of the minutes the session is waiting for. */
  minutesTurnId: z.uuid().nullable().default(null),
  minutesDocId: z.uuid().nullable().default(null),
  /** Set when minutes were requested on demand while the session goes on. */
  minutesRequested: z.boolean().default(false),
  prdSessionId: z.uuid().nullable().default(null),
  /** The PRD document reserved by a "pull into PRD" that has not finished: a retry reuses it instead of making another. */
  prdPullDocId: z.uuid().nullable().default(null),
  suggestions: z.array(BoardSuggestionSchema).default([]),
  suggestState: z.enum(['asking', 'done', 'failed']).nullable().default(null),
  roomId: z.uuid().nullable().default(null),
});
export type BoardConfig = z.infer<typeof BoardConfigSchema>;

/** The config of a session row, with defaults filled in. Never throws: a malformed key falls back to its default. */
export function parseBoardConfig(raw: unknown): BoardConfig {
  const r = BoardConfigSchema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const k of Object.keys(BoardConfigSchema.shape)) {
    const one = BoardConfigSchema.shape[k as keyof typeof BoardConfigSchema.shape].safeParse(o[k]);
    if (one.success) safe[k] = one.data;
  }
  return BoardConfigSchema.parse(safe);
}

// ------------------------------------------------------------------------------------------------- names and @mentions

/** `Devil's Advocate` -> `devils-advocate`: the handle used by `@mentions` and by the Chair's `--speaker`. */
export function participantSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface Mentionable {
  id: string;
  /** All handles that reach this participant (display name, persona key, seat). */
  handles: string[];
}

export const MENTION_ALL = ['all', 'everyone', 'team'];

/** Participant ids an owner message mentions, in the order of the mentions. `@all` is every id in `allIds`. */
export function parseMentions(
  body: string,
  people: readonly Mentionable[],
  allIds: readonly string[],
): string[] {
  const out: string[] = [];
  const re = /(^|[^\w@/.])@([a-z0-9][a-z0-9-]*)/gi;
  for (const m of body.matchAll(re)) {
    const h = (m[2] as string).toLowerCase().replace(/-+$/, '');
    if (MENTION_ALL.includes(h)) {
      for (const id of allIds) if (!out.includes(id)) out.push(id);
      continue;
    }
    const hit = people.find((p) => p.handles.includes(h));
    if (hit && !out.includes(hit.id)) out.push(hit.id);
  }
  return out;
}

export function handlesOf(p: { displayName: string; refId: string; seat: string; kind: string }): string[] {
  const hs = new Set<string>([participantSlug(p.displayName)]);
  if (p.seat !== CAST_SEAT_DEFAULT) hs.add(participantSlug(p.seat));
  if (p.kind === 'persona') hs.add(p.refId.replace(/^ad-hoc-/, ''));
  hs.delete('');
  return [...hs];
}

// ------------------------------------------------------------------------------------------------- cast, rooms, requests

export const CastMemberSchema = z
  .object({
    kind: z.enum(['persona', 'agent']),
    /** Persona key (`ad-hoc-<slug>` for one cast from a brief) or agent id. */
    refId: z.string().min(1).max(80),
    seat: z.string().min(1).max(60).optional(),
    /** One-line brief of an ad-hoc persona; also overrides a library persona's stance in this room. */
    stance: z.string().max(500).optional(),
    displayName: z.string().min(1).max(100).optional(),
    /** Runtime and model for this seat (absent: the room's persona model, or the agent's own). */
    model: ModelChoiceSchema.optional(),
  })
  .superRefine((m, ctx) => {
    if (m.kind === 'agent' && !z.uuid().safeParse(m.refId).success)
      ctx.addIssue({ code: 'custom', path: ['refId'], message: 'an agent is named by its id' });
    if (m.kind === 'persona' && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.refId))
      ctx.addIssue({
        code: 'custom',
        path: ['refId'],
        message: 'a persona key is lowercase letters, digits and hyphens',
      });
  });
export type CastMember = z.infer<typeof CastMemberSchema>;

export const BoardSettingsSchema = z.object({
  format: BoardFormatSchema.default('open'),
  roundCap: z.number().int().min(1).max(BOARD_ROUND_CAP_MAX).default(BOARD_ROUND_CAP_DEFAULT),
  budgetUsd: z.number().positive().max(100_000).optional(),
  models: BoardModelsSchema.default({}),
});

export const CreateBoardRequestSchema = BoardSettingsSchema.extend({
  title: z.string().min(1).max(200).optional(),
  topic: z.string().min(1).max(2000),
  brief: z.string().max(8000).default(''),
  cast: z.array(CastMemberSchema).min(BOARD_CAST_MIN).max(BOARD_CAST_MAX),
  projectId: z.uuid().optional(),
  workstationId: z.uuid().optional(),
  /** The room this cast came from, kept for display. */
  roomId: z.uuid().optional(),
});
export type CreateBoardRequest = z.infer<typeof CreateBoardRequestSchema>;

/** `POST /api/board/suggest`: a session in `setup` with only the Chair, whose first turn proposes a cast. */
export const SuggestCastRequestSchema = z.object({
  topic: z.string().min(1).max(2000),
  brief: z.string().max(8000).default(''),
  format: BoardFormatSchema.default('open'),
  projectId: z.uuid().optional(),
  workstationId: z.uuid().optional(),
});
export type SuggestCastRequest = z.infer<typeof SuggestCastRequestSchema>;

/** `POST /api/board/:id/start`: the cast is chosen (from the suggestions or by hand) and round 1 begins. */
export const StartBoardRequestSchema = CreateBoardRequestSchema.omit({
  projectId: true,
  workstationId: true,
});
export type StartBoardRequest = z.infer<typeof StartBoardRequestSchema>;

export const PatchBoardRequestSchema = z.object({
  budgetUsd: z.number().positive().max(100_000).nullable().optional(),
  roundCap: z.number().int().min(1).max(BOARD_ROUND_CAP_MAX).optional(),
  models: BoardModelsSchema.optional(),
});
export type PatchBoardRequest = z.infer<typeof PatchBoardRequestSchema>;

export const BoardSayRequestSchema = z.object({ body: z.string().min(1).max(8000) });
export const BoardResolveDecisionRequestSchema = z.object({
  answer: z.string().max(4000).default(''),
  optionId: z.string().max(20).optional(),
});
export const BoardParamsSchema = z.object({ id: z.uuid() });
export const BoardNoteParamsSchema = z.object({ id: z.uuid(), noteId: z.uuid() });
export const BoardDecisionParamsSchema = z.object({ id: z.uuid(), decisionId: z.uuid() });
export const BoardRoomParamsSchema = z.object({ id: z.uuid() });

export const AddBoardNoteRequestSchema = z.object({
  column: StickyColumnSchema,
  text: z.string().min(1).max(600),
});
export const PatchBoardNoteRequestSchema = z
  .object({ column: StickyColumnSchema.optional(), text: z.string().min(1).max(600).optional() })
  .refine((v) => v.column !== undefined || v.text !== undefined, 'nothing to change');
export const MergeBoardNotesRequestSchema = z.object({
  /** The first note survives; the others are folded into it. */
  noteIds: z.array(z.uuid()).min(2).max(12),
  text: z.string().min(1).max(600).optional(),
});

export const BoardRoomSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(100),
  format: BoardFormatSchema,
  roundCap: z.number().int(),
  cast: z.array(CastMemberSchema),
  models: BoardModelsSchema,
  createdAt: z.iso.datetime(),
});
export type BoardRoom = z.infer<typeof BoardRoomSchema>;
export const SaveBoardRoomRequestSchema = z.object({
  name: z.string().min(1).max(100),
  format: BoardFormatSchema.default('open'),
  roundCap: z.number().int().min(1).max(BOARD_ROUND_CAP_MAX).default(BOARD_ROUND_CAP_DEFAULT),
  cast: z.array(CastMemberSchema).min(BOARD_CAST_MIN).max(BOARD_CAST_MAX),
  models: BoardModelsSchema.default({}),
});
export type SaveBoardRoomRequest = z.infer<typeof SaveBoardRoomRequestSchema>;

// ------------------------------------------------------------------------------------------------- the state the page shows

export const BoardCastDtoSchema = z.object({
  participantId: z.uuid(),
  kind: ParticipantKindSchema,
  refId: z.string(),
  seat: z.string(),
  displayName: z.string(),
  slug: z.string(),
  stance: z.string().nullable(),
  icon: z.string().nullable(),
  model: ModelChoiceSchema.nullable(),
  /** Position in the cast: the page derives the colour from it. */
  index: z.number().int(),
});
export type BoardCastDto = z.infer<typeof BoardCastDtoSchema>;

export const BoardNoteDtoSchema = z.object({
  id: z.uuid(),
  column: StickyColumnSchema,
  text: z.string(),
  byKind: z.enum(['user', 'agent', 'persona', 'system']),
  byName: z.string(),
  round: z.number().int().nullable(),
  votes: z.number().int(),
  votedByMe: z.boolean(),
  mergedFrom: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type BoardNoteDto = z.infer<typeof BoardNoteDtoSchema>;

export const BoardDisagreementDtoSchema = z.object({
  id: z.uuid(),
  topic: z.string(),
  positions: z.array(z.object({ who: z.string(), position: z.string() })),
  round: z.number().int().nullable(),
  byName: z.string(),
  createdAt: z.iso.datetime(),
});
export type BoardDisagreementDto = z.infer<typeof BoardDisagreementDtoSchema>;

export const BoardDecisionDtoSchema = z.object({
  id: z.uuid(),
  question: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
  round: z.number().int().nullable(),
  status: z.enum(['open', 'resolved', 'withdrawn']),
  answer: z.string().nullable(),
  optionId: z.string().nullable(),
  askedByName: z.string(),
  askedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type BoardDecisionDto = z.infer<typeof BoardDecisionDtoSchema>;

export const BoardRoundDtoSchema = z.object({
  round: z.number().int(),
  kind: BoardRoundKindSchema,
  speakers: z.array(z.object({ participantId: z.uuid(), name: z.string() })),
  reason: z.string(),
  instruction: z.string(),
  source: z.enum(['independent', 'chair', 'fallback']),
  plannedAt: z.iso.datetime(),
  /** `running` until every speaker's turn ended. */
  status: z.enum(['running', 'done']),
});
export type BoardRoundDto = z.infer<typeof BoardRoundDtoSchema>;

export const BoardWaitingSchema = z.enum([
  'cast',
  'speakers',
  'chair',
  'decision',
  'owner',
  'minutes',
  'budget',
  'paused',
  'ended',
  'nothing',
]);

export const BoardStateDtoSchema = z.object({
  threadId: z.uuid(),
  title: z.string(),
  projectId: z.uuid().nullable(),
  config: z.object({
    topic: z.string(),
    brief: z.string(),
    format: BoardFormatSchema,
    roundCap: z.number().int(),
    stage: BoardStageSchema,
    round: z.number().int(),
    revealedRound: z.number().int(),
    paused: z.boolean(),
    budgetStopped: z.boolean(),
    endReason: z.enum(['owner', 'round_cap']).nullable(),
    models: BoardModelsSchema,
    dissentNext: z.boolean(),
    minutesDocId: z.uuid().nullable(),
    prdSessionId: z.uuid().nullable(),
    suggestState: z.enum(['asking', 'done', 'failed']).nullable(),
  }),
  cast: z.array(BoardCastDtoSchema),
  chair: z.object({ participantId: z.uuid().nullable(), displayName: z.string() }),
  rounds: z.array(BoardRoundDtoSchema),
  notes: z.array(BoardNoteDtoSchema),
  /** Notes written by speakers in a sealed round, not shown yet. */
  hiddenNotes: z.number().int(),
  disagreements: z.array(BoardDisagreementDtoSchema),
  decisions: z.array(BoardDecisionDtoSchema),
  suggestions: z.array(BoardSuggestionSchema),
  /** Messages of the sealed round: the page does not show them until the round is revealed. */
  sealedMessageIds: z.array(z.uuid()),
  /** Speakers whose answer for the sealed round is in (names only; the text stays hidden). */
  sealedProgress: z.object({ done: z.number().int(), total: z.number().int() }).nullable(),
  documents: z.array(
    z.object({
      id: z.uuid(),
      kind: z.string(),
      title: z.string(),
      status: z.string(),
      currentVersion: z.number().int(),
    }),
  ),
  turns: z.array(SessionTurnDtoSchema),
  cost: SessionCostSchema,
  estimate: z.object({
    speakers: z.number().int(),
    usd: z.number().nonnegative(),
    basis: z.enum(['average', 'default']),
  }),
  workstationOnline: z.boolean(),
  ceoAvailable: z.boolean(),
  busy: z.boolean(),
  waitingFor: BoardWaitingSchema,
  /** The Chair's latest words about the pick ("Chair picks: X, Y"), from the current plan. */
  chairStatus: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type BoardStateDto = z.infer<typeof BoardStateDtoSchema>;

export interface NextRoundEstimate {
  speakers: number;
  usd: number;
  basis: 'average' | 'default';
}

/**
 * Cost of the next round from the cast size: the speakers a round has (everyone in round 1, otherwise at most three), times
 * what a speaker turn has cost so far on average, plus one Chair turn for the rounds after the first. Pure.
 */
export function estimateNextRound(i: {
  castSize: number;
  nextRound: number;
  avgSpeakerTurnUsd: number | null;
  avgChairTurnUsd: number | null;
}): NextRoundEstimate {
  const speakers = i.nextRound <= 1 ? i.castSize : Math.min(BOARD_SPEAKERS_MAX, i.castSize);
  const turn = i.avgSpeakerTurnUsd ?? BOARD_DEFAULT_TURN_USD;
  const chair = i.nextRound <= 1 ? 0 : (i.avgChairTurnUsd ?? BOARD_DEFAULT_TURN_USD);
  return {
    speakers,
    usd: Math.round((speakers * turn + chair) * 10_000) / 10_000,
    basis: i.avgSpeakerTurnUsd === null ? 'default' : 'average',
  };
}

// ------------------------------------------------------------------------------------------------- aom board verbs

export const BOARD_RPC_METHODS = [
  'board.show',
  'board.add',
  'board.next',
  'board.pause',
  'board.converge',
  'board.disagreement',
  'board.cast',
  'board.minutes',
] as const;
export type BoardRpcMethod = (typeof BOARD_RPC_METHODS)[number];
export const isBoardRpc = (m: string): m is BoardRpcMethod =>
  (BOARD_RPC_METHODS as readonly string[]).includes(m);

export const BoardAddParamsSchema = z.object({
  column: StickyColumnSchema,
  text: z.string().min(1).max(600),
});
export const BoardNextParamsSchema = z.object({
  /** Participant handles (`@`-slug, name or id prefix), in speaking order. */
  speakers: z.array(z.string().min(1).max(100)).min(1).max(8),
  reason: z.string().min(1).max(600),
  /** What this round should focus on (shown to every speaker of it). */
  instruction: z.string().max(1000).optional(),
});
export const BoardPauseParamsSchema = z.object({
  question: z.string().min(1).max(600),
  options: z.array(z.string().min(1).max(200)).max(6).default([]),
});
export const BoardConvergeParamsSchema = z.object({ note: z.string().min(1).max(600) });
export const BoardDisagreementParamsSchema = z.object({
  topic: z.string().min(1).max(300),
  /** Each `<who>|<their position>`. */
  positions: z.array(z.string().min(3).max(600)).min(2).max(8),
});
export const BoardCastParamsSchema = z
  .object({
    persona: z.string().max(80).optional(),
    name: z.string().min(1).max(100).optional(),
    brief: z.string().min(1).max(500).optional(),
    seat: z.string().min(1).max(60).optional(),
    why: z.string().max(400).default(''),
  })
  .refine((v) => v.persona || (v.name && v.brief), 'name a library persona, or give --name and --brief');
export const BoardMinutesParamsSchema = z.object({ content: z.string().min(1).max(120_000) });

/** Parses `who|position` (the `aom board disagreement add --position` form). */
export function parsePosition(s: string): { who: string; position: string } | null {
  const i = s.indexOf('|');
  if (i < 1) return null;
  const who = s.slice(0, i).trim();
  const position = s.slice(i + 1).trim();
  return who && position ? { who, position } : null;
}

/** Short id shown to the Chair for a sticky (the first 8 characters of its uuid). */
export const boardShortId = (id: string): string => id.slice(0, 8);

/** Cut a reply at `max` characters on a sentence or word boundary, with a visible mark. Pure. */
export function capTurnText(text: string, max = BOARD_TURN_MAX_CHARS): { text: string; cut: boolean } {
  const t = text.trim();
  if (t.length <= max) return { text: t, cut: false };
  const head = t.slice(0, max);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  const word = head.lastIndexOf(' ');
  const at = sentence > max * 0.6 ? sentence + 1 : word > max * 0.6 ? word : max;
  return { text: `${head.slice(0, at).trimEnd()} …`, cut: true };
}

// ------------------------------------------------------------------------------------------------- choosing speakers

export interface SpeakerCandidate {
  id: string;
  /** Turns this participant has had in the session. */
  spoken: number;
}

export interface PickResult {
  speakers: string[];
  /** Why the server changed the Chair's pick (shown with the plan). */
  notes: string[];
}

/**
 * The rules for who speaks next, applied to the Chair's pick (and used to make one when the Chair gave none). Rules:
 * participants the owner @mentioned always speak, first; nobody is listed twice; the first speaker is not the one who spoke
 * last (a mention is the owner's explicit wish and is exempt); at most `BOARD_SPEAKERS_MAX` besides the mentioned.
 * Without a pick, the least heard speakers go first. Pure and deterministic.
 */
export function chooseSpeakers(i: {
  candidates: readonly SpeakerCandidate[];
  picked: readonly string[];
  mentions: readonly string[];
  lastSpeakerId: string | null;
}): PickResult {
  const ids = new Set(i.candidates.map((c) => c.id));
  const notes: string[] = [];
  const mentioned = i.mentions.filter((m, k, a) => ids.has(m) && a.indexOf(m) === k);
  let picked = i.picked.filter((p, k, a) => ids.has(p) && a.indexOf(p) === k && !mentioned.includes(p));
  if (picked.length < i.picked.length) notes.push('Duplicates and unknown speakers were dropped.');
  const heard = (id: string) => i.candidates.find((c) => c.id === id)?.spoken ?? 0;
  if (!picked.length && !mentioned.length) {
    picked = [...i.candidates]
      .filter((c) => c.id !== i.lastSpeakerId)
      .sort((a, b) => a.spoken - b.spoken || a.id.localeCompare(b.id))
      .map((c) => c.id)
      .slice(0, 2);
    notes.push('The Chair gave no usable pick: the least heard speakers were chosen.');
  }
  const room = Math.max(0, BOARD_SPEAKERS_MAX - mentioned.length);
  let rest = picked.slice(0, room);
  if (mentioned.length) notes.push('Mentioned by the owner, so they speak first.');
  // Never the same speaker twice in a row: the last speaker may not open the round (unless the owner asked for them).
  if (rest.length && rest[0] === i.lastSpeakerId && !mentioned.length) {
    const swap = rest.findIndex((r) => r !== i.lastSpeakerId);
    if (swap > 0) {
      rest = [rest[swap] as string, ...rest.filter((_, k) => k !== swap)];
    } else {
      const alt = [...i.candidates]
        .filter((c) => c.id !== i.lastSpeakerId && !rest.includes(c.id))
        .sort((a, b) => heard(a.id) - heard(b.id) || a.id.localeCompare(b.id))[0];
      rest = alt ? [alt.id, ...rest.filter((r) => r !== i.lastSpeakerId)] : rest;
    }
    notes.push('The last speaker cannot open the next round.');
  }
  const speakers = [...mentioned, ...rest.filter((r) => !mentioned.includes(r))];
  if (
    speakers.length === 1 &&
    speakers[0] === i.lastSpeakerId &&
    i.candidates.length > 1 &&
    !mentioned.length
  ) {
    const alt = i.candidates.find((c) => c.id !== i.lastSpeakerId);
    if (alt) speakers.splice(0, 1, alt.id);
  }
  return { speakers: speakers.slice(0, Math.max(BOARD_SPEAKERS_MAX, mentioned.length)), notes };
}

/** Finds the participant a `--speaker` handle names: slug, display name, persona key or the start of an id. */
export function resolveHandle(
  handle: string,
  people: readonly { id: string; displayName: string; refId: string; seat: string; kind: string }[],
): string | null {
  const h = handle.trim().replace(/^@/, '').toLowerCase();
  const slug = participantSlug(h);
  const hit =
    people.find((p) => handlesOf(p).includes(slug)) ??
    people.find((p) => p.displayName.toLowerCase() === h) ??
    people.find((p) => h.length >= 6 && p.id.startsWith(h));
  return hit?.id ?? null;
}
