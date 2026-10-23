import { z } from 'zod';
import {
  BoardAddParamsSchema,
  BoardCastParamsSchema,
  BoardConvergeParamsSchema,
  BoardDisagreementParamsSchema,
  BoardMinutesParamsSchema,
  BoardNextParamsSchema,
  BoardPauseParamsSchema,
} from '../boardroom/index.ts';
import {
  PanelSectionSchema,
  SessionAnswerParamsSchema,
  SessionAskParamsSchema,
  SessionDraftParamsSchema,
  SessionPhaseParamsSchema,
  SessionProposeParamsSchema,
  SessionValidateParamsSchema,
} from '../discovery/index.ts';

/**
 * What each kind of session turn may do through the `aom` verbs, by `session_turns.meta.purpose`. The server enforces it
 * (`sessionVerb`, `boardVerb`) whichever runtime asked; the direct-model runtime also uses it to decide which tools to show the
 * model, so a model is not offered a tool the server would refuse. One table, so the two can never disagree.
 */
export const SESSION_PURPOSE_VERBS: Readonly<Record<string, readonly string[]>> = {
  facilitator: ['show', 'ask', 'note', 'propose', 'phase', 'draft', 'validate'],
  ceo_answer: ['show', 'answer', 'note'],
  board_speaker: ['show', 'add', 'disagreement'],
  board_chair: ['show', 'add', 'next', 'pause', 'converge', 'disagreement'],
  board_cast: ['cast'],
  board_minutes: ['show', 'minutes'],
};

const purposesWhere = (board: boolean): Record<string, readonly string[]> =>
  Object.fromEntries(Object.entries(SESSION_PURPOSE_VERBS).filter(([k]) => k.startsWith('board_') === board));
/** The `aom session` verbs by purpose (discovery turns) and the `aom board` verbs by purpose (boardroom turns). */
export const DISCOVERY_PURPOSE_VERBS = purposesWhere(false);
export const BOARD_PURPOSE_VERBS = purposesWhere(true);

/**
 * A tool of the direct-model runtime. It is an `aom` verb (or `aom skill` / `aom ledger search`) with a typed input:
 * `rpc` and the input are exactly what the `aom` CLI would send over the runner's IPC, so the call takes the same path
 * (runner IPC handler, then the server's per-turn permission check) as the Claude Code path.
 */
export interface SessionToolDef {
  /** Tool name shown to the model (`board_add`). */
  name: string;
  /** The `aom` command it replaces, for the instructions (`aom board add`). */
  cli: string;
  /** The rpc method (`board.add`). */
  rpc: string;
  /** The verb checked against `SESSION_PURPOSE_VERBS` (`add`); absent: allowed in every session turn. */
  verb?: string;
  /** `board` or `session` (which purposes list the verb); absent for skill and ledger tools. */
  family?: 'session' | 'board';
  description: string;
  input: z.ZodType;
  /** Fixed rpc parameters merged into the input (`{op: 'add'}` for `session.note`). */
  fixed?: Record<string, unknown>;
}

const NoteIdSchema = z.string().min(4).max(40).describe('The short id of the note, as `session_show` lists it.');

export const SESSION_TOOLS: readonly SessionToolDef[] = [
  {
    name: 'session_show',
    cli: 'aom session show',
    rpc: 'session.show',
    verb: 'show',
    family: 'session',
    description:
      'Show the session so far: the questions and answers and the panel (ideas, assumptions, open questions, decisions, parked).',
    input: z.object({}),
  },
  {
    name: 'session_ask',
    cli: 'aom session ask',
    rpc: 'session.ask',
    verb: 'ask',
    family: 'session',
    description:
      'Ask the owner ONE question as a card, with quick-pick options. Ask one question per turn; a new question withdraws the open one.',
    input: SessionAskParamsSchema,
  },
  {
    name: 'session_answer',
    cli: 'aom session answer',
    rpc: 'session.answer',
    verb: 'answer',
    family: 'session',
    description:
      'Propose an answer to the open question (the owner confirms or overrides). Give `option` (an option id) and/or `text`.',
    input: SessionAnswerParamsSchema,
  },
  {
    name: 'session_note_add',
    cli: 'aom session note add',
    rpc: 'session.note',
    verb: 'note',
    family: 'session',
    fixed: { op: 'add' },
    description: 'Add a note to a section of the live panel.',
    input: z.object({ section: PanelSectionSchema, text: z.string().min(1).max(2000) }),
  },
  {
    name: 'session_note_update',
    cli: 'aom session note update',
    rpc: 'session.note',
    verb: 'note',
    family: 'session',
    fixed: { op: 'update' },
    description: 'Change the text or the section of a panel note.',
    input: z.object({
      id: NoteIdSchema,
      text: z.string().min(1).max(2000).optional(),
      section: PanelSectionSchema.optional(),
    }),
  },
  {
    name: 'session_note_remove',
    cli: 'aom session note remove',
    rpc: 'session.note',
    verb: 'note',
    family: 'session',
    fixed: { op: 'remove' },
    description: 'Remove a panel note.',
    input: z.object({ id: NoteIdSchema }),
  },
  {
    name: 'session_propose',
    cli: 'aom session propose',
    rpc: 'session.propose',
    verb: 'propose',
    family: 'session',
    description:
      'Propose a change to the panel or a draft. Nothing is applied until the owner clicks Apply; you never apply it yourself.',
    input: SessionProposeParamsSchema,
  },
  {
    name: 'session_phase',
    cli: 'aom session phase',
    rpc: 'session.phase',
    verb: 'phase',
    family: 'session',
    description: 'Move the session to another phase (the owner can override it).',
    input: SessionPhaseParamsSchema,
  },
  {
    name: 'session_draft',
    cli: 'aom session draft',
    rpc: 'session.draft',
    verb: 'draft',
    family: 'session',
    description: 'Create or update the brief or the PRD draft of this session (markdown in `content`).',
    input: SessionDraftParamsSchema,
  },
  {
    name: 'session_validate',
    cli: 'aom session validate',
    rpc: 'session.validate',
    verb: 'validate',
    family: 'session',
    description:
      'Record the PRD validation. Each item is `<criterion>|pass|fail|n/a|<note>`; add a short `summary`.',
    input: SessionValidateParamsSchema,
  },
  {
    name: 'board_show',
    cli: 'aom board show',
    rpc: 'board.show',
    verb: 'show',
    family: 'board',
    description: 'Show the whiteboard, the recorded disagreements and the open decisions of the boardroom.',
    input: z.object({}),
  },
  {
    name: 'board_add',
    cli: 'aom board add',
    rpc: 'board.add',
    verb: 'add',
    family: 'board',
    description: 'Put a sticky note on the whiteboard (at most two per turn for a speaker).',
    input: BoardAddParamsSchema,
  },
  {
    name: 'board_next',
    cli: 'aom board next',
    rpc: 'board.next',
    verb: 'next',
    family: 'board',
    description:
      'Chair only: choose who speaks next (handles in speaking order) and why. The server applies its own rules to your pick.',
    input: BoardNextParamsSchema,
  },
  {
    name: 'board_pause',
    cli: 'aom board pause',
    rpc: 'board.pause',
    verb: 'pause',
    family: 'board',
    description: 'Chair only: stop the debate and put a decision to the owner, with options.',
    input: BoardPauseParamsSchema,
  },
  {
    name: 'board_converge',
    cli: 'aom board converge',
    rpc: 'board.converge',
    verb: 'converge',
    family: 'board',
    description: 'Chair only: flag that the board agrees too early, so the next round steel-mans the other side.',
    input: BoardConvergeParamsSchema,
  },
  {
    name: 'board_disagreement',
    cli: 'aom board disagreement add',
    rpc: 'board.disagreement',
    verb: 'disagreement',
    family: 'board',
    description: 'Record a disagreement: the topic and each position as `<Name>|<their view>` (two or more).',
    input: BoardDisagreementParamsSchema,
  },
  {
    name: 'board_cast',
    cli: 'aom board cast',
    rpc: 'board.cast',
    verb: 'cast',
    family: 'board',
    description: 'Suggest one voice for the cast: a library persona (`persona`) or a new one (`name` and `brief`).',
    input: BoardCastParamsSchema,
  },
  {
    name: 'board_minutes',
    cli: 'aom board minutes',
    rpc: 'board.minutes',
    verb: 'minutes',
    family: 'board',
    description: 'Save the minutes synthesis (markdown with `##` headings).',
    input: BoardMinutesParamsSchema,
  },
];

/** Tools every session turn has, whatever it is for: the capability registry and the decision ledger. */
export const COMMON_TOOLS: readonly SessionToolDef[] = [
  {
    name: 'skill_show',
    cli: 'aom skill show',
    rpc: 'skill.show',
    description:
      'Load a skill, persona or playbook from the capability index (`ref` is its key, or `kind:key`). `file` reads another file of it.',
    input: z.object({ ref: z.string().min(1).max(200), file: z.string().min(1).max(300).optional() }),
  },
  {
    name: 'skill_list',
    cli: 'aom skill list',
    rpc: 'skill.list',
    description: 'List the capabilities available, optionally of one `kind` (skill, persona or playbook).',
    input: z.object({ kind: z.enum(['skill', 'persona', 'playbook']).optional() }),
  },
  {
    name: 'ledger_search',
    cli: 'aom ledger search',
    rpc: 'ledger.search',
    description: "Search the organization's decisions, features and standing orders.",
    input: z.object({
      query: z.string().min(1).max(500),
      scope: z.enum(['all', 'feature', 'decision', 'standing_order']).default('all'),
    }),
  },
];

/**
 * The tools a turn is offered: the common ones, plus the verbs its purpose allows. A turn with no purpose (a persona talking
 * in a plain session message) only gets the common ones, as the server allows it nothing else.
 */
export function sessionToolsFor(purpose: string | undefined): SessionToolDef[] {
  const verbs = purpose ? (SESSION_PURPOSE_VERBS[purpose] ?? []) : [];
  const own = SESSION_TOOLS.filter((t) => t.verb && t.family && verbs.includes(t.verb) && familyMatches(t, purpose));
  return [...own, ...COMMON_TOOLS];
}

/** `show` exists in both families: a board purpose uses the board's, a discovery purpose the session's. */
function familyMatches(t: SessionToolDef, purpose: string | undefined): boolean {
  const board = !!purpose?.startsWith('board_');
  return t.family === (board ? 'board' : 'session');
}

/** Tools for a plain chat (no session purpose): reading the registry and the ledger. */
export const chatToolsFor = (): SessionToolDef[] => [...COMMON_TOOLS];

/** `aom board add ...` -> `board_add`: lines for the system prompt of a runtime that has tools and no shell. */
export function renderToolMapping(tools: readonly SessionToolDef[]): string {
  return tools.map((t) => `- \`${t.cli} ...\` -> tool \`${t.name}\``).join('\n');
}
