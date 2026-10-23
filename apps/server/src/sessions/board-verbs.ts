import { randomUUID } from 'node:crypto';
import {
  BOARD_NOTES_PER_TURN,
  BOARD_PURPOSE_VERBS,
  BoardAddParamsSchema,
  BoardCastParamsSchema,
  BoardConvergeParamsSchema,
  BoardDisagreementParamsSchema,
  BoardMinutesParamsSchema,
  BoardNextParamsSchema,
  BoardPauseParamsSchema,
  type BoardRpcMethod,
  boardShortId,
  parseBoardConfig,
  parsePosition,
  participantSlug,
  renderBoardNotes,
  renderDisagreements,
  resolveHandle,
  streamId,
} from '@aom/shared';
import { resolvePersona } from '../capabilities/registry.ts';
import { SYSTEM_ACTOR } from '../commands/common.ts';
import { sessionScope } from '../commands/sessions.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import type { BoardService } from './board.ts';
import { castOf, listBoardNotes, listDisagreements } from './board-state.ts';

type Reply = [boolean, unknown?, string?];

const zodText = (issues: Array<{ path: PropertyKey[]; message: string }>): string =>
  issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');

const PURPOSE_VERBS = BOARD_PURPOSE_VERBS;

export const actorOf = (turn: Row): AppendInput['actor'] =>
  turn.agent_id
    ? { kind: 'agent', id: turn.agent_id }
    : { kind: 'runner', id: turn.workstation_id ?? SYSTEM_ACTOR.id };
export const authorOf = (turn: Row) => ({
  kind: turn.agent_id ? ('agent' as const) : ('persona' as const),
  id: (turn.agent_id ?? turn.persona_key ?? null) as string | null,
  name: turn.speaker_name as string,
});

/**
 * The server side of `aom board ...` for a boardroom turn. Which verbs a turn may use follows from what the turn is for
 * (`session_turns.meta.purpose`): speakers add notes and record disagreements, the Chair also chooses the next speakers,
 * flags convergence and pauses for a decision, the cast turn suggests voices, the minutes turn saves the synthesis.
 */
export async function boardVerb(
  svc: BoardService,
  ctx: Ctx,
  turn: Row,
  method: BoardRpcMethod,
  params: Record<string, unknown>,
): Promise<Reply> {
  const verb = method.slice('board.'.length);
  const purpose = (turn.meta as { purpose?: string } | null)?.purpose ?? '';
  if (!PURPOSE_VERBS[purpose])
    return [
      false,
      undefined,
      'this turn has no part in a boardroom: only `aom skill` and `aom ledger search` are available',
    ];
  if (!PURPOSE_VERBS[purpose]?.includes(verb))
    return [false, undefined, `\`aom board ${verb}\` is not available in this turn`];
  const t = await one(
    ctx.pool,
    `SELECT * FROM threads WHERE id=$1 AND kind='boardroom' AND deleted_at IS NULL`,
    [turn.thread_id],
  );
  if (!t) return [false, undefined, 'the session no longer exists'];
  return svc.serialized(t.id, async () => {
    const fresh = (await one(ctx.pool, 'SELECT * FROM threads WHERE id=$1', [t.id])) as Row;
    try {
      switch (verb) {
        case 'show':
          return await show(ctx, fresh, turn);
        case 'add':
          return await add(ctx, fresh, turn, purpose, params);
        case 'next':
          return await next(svc, fresh, turn, params);
        case 'pause':
          return await pause(svc, ctx, fresh, turn, params);
        case 'converge':
          return await converge(svc, ctx, fresh, turn, params);
        case 'disagreement':
          return await disagreement(ctx, fresh, turn, params);
        case 'cast':
          return await cast(svc, ctx, fresh, turn, params);
        case 'minutes':
          return await minutes(svc, fresh, turn, params);
        default:
          return [false, undefined, `unknown verb ${verb}`];
      }
    } catch (err) {
      return [false, undefined, err instanceof Error ? err.message : String(err)];
    }
  });
}

async function show(ctx: Ctx, t: Row, turn: Row): Promise<Reply> {
  const cfg = parseBoardConfig(t.session_config);
  const meta = turn.meta as { kind?: string };
  // In the independent first round nobody sees what the others wrote.
  if (meta.kind === 'independent' && cfg.revealedRound < 1)
    return [true, { text: 'The whiteboard is sealed until every first answer is in. Give your own view.' }];
  const [n, d] = await Promise.all([listBoardNotes(ctx.pool, t.id), listDisagreements(ctx.pool, t.id)]);
  const text = [
    '## Whiteboard',
    renderBoardNotes(
      n.map((x) => ({
        id: x.id,
        column: x.col,
        text: x.text,
        byName: x.by_name,
        votes: (x.votes as string[]).length,
      })),
    ),
    '## Recorded disagreements',
    renderDisagreements(d.map((x) => ({ topic: x.topic, positions: x.positions }))),
  ].join('\n');
  return [true, { text }];
}

async function add(
  ctx: Ctx,
  t: Row,
  turn: Row,
  purpose: string,
  params: Record<string, unknown>,
): Promise<Reply> {
  const p = BoardAddParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      `usage: aom board add --column ideas|risks|questions|decisions|parked --text "<text>" (${zodText(p.error.issues)})`,
    ];
  const cap = purpose === 'board_chair' ? BOARD_NOTES_PER_TURN * 2 : BOARD_NOTES_PER_TURN;
  const used = await one(ctx.pool, 'SELECT count(*)::int AS n FROM board_notes WHERE turn_id=$1', [turn.id]);
  if ((used?.n ?? 0) >= cap)
    return [false, undefined, `You already added ${cap} notes this turn: keep the board for what matters.`];
  const dup = await one(
    ctx.pool,
    `SELECT id FROM board_notes WHERE thread_id=$1 AND col=$2 AND lower(text)=lower($3) AND removed_at IS NULL`,
    [t.id, p.data.column, p.data.text],
  );
  if (dup) return [true, { message: 'That note is already on the board.' }];
  const noteId = randomUUID();
  await ctx.store.append([
    {
      streamId: streamId.thread(t.id),
      event: {
        type: 'BoardNoteAdded',
        payload: {
          threadId: t.id,
          noteId,
          column: p.data.column,
          text: p.data.text,
          by: authorOf(turn),
          round: turn.round ?? null,
          turnId: turn.id,
        },
      },
      actor: actorOf(turn),
      scope: sessionScope(t),
    },
  ]);
  return [true, { id: boardShortId(noteId), message: `Added to ${p.data.column}.` }];
}

async function next(svc: BoardService, t: Row, turn: Row, params: Record<string, unknown>): Promise<Reply> {
  const p = BoardNextParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      `usage: aom board next --speaker <handle> [--speaker <handle>] --reason "<why>" [--instruction "<focus>"] (${zodText(p.error.issues)})`,
    ];
  const cfg = parseBoardConfig(t.session_config);
  if (cfg.stage !== 'chair')
    return [
      false,
      undefined,
      'The next round is already planned (or the session is waiting for the owner): finish your turn.',
    ];
  const cast = await castOf(svc.ctx.pool, t.id);
  const handles = cast.map((c) => ({
    id: c.id,
    displayName: c.display_name,
    refId: c.ref_id,
    seat: c.seat,
    kind: c.kind,
  }));
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const h of p.data.speakers) {
    const id = resolveHandle(h, handles);
    if (id) ids.push(id);
    else unknown.push(h);
  }
  if (unknown.length && !ids.length)
    return [false, undefined, `No such speaker: ${unknown.join(', ')}. Use a handle from the roster.`];
  const planned = await svc.planDiscussion(t, cfg, {
    picked: ids,
    reason: p.data.reason,
    instruction: p.data.instruction ?? '',
    source: 'chair',
    turnId: turn.id,
  });
  const names = planned.speakers.map((id) => cast.find((c) => c.id === id)?.display_name ?? id).join(', ');
  return [
    true,
    {
      message: `Round ${planned.round} (${planned.kind}) planned: ${names}.${planned.notes.length ? ` Adjusted by the server: ${planned.notes.join(' ')}` : ''}${unknown.length ? ` Unknown handles ignored: ${unknown.join(', ')}.` : ''} Finish your turn now.`,
    },
  ];
}

async function pause(
  svc: BoardService,
  ctx: Ctx,
  t: Row,
  turn: Row,
  params: Record<string, unknown>,
): Promise<Reply> {
  const p = BoardPauseParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      `usage: aom board pause --question "<q>" [--option "<a>"]... (${zodText(p.error.issues)})`,
    ];
  const cfg = parseBoardConfig(t.session_config);
  if (cfg.stage !== 'chair')
    return [false, undefined, 'The round is already planned: you cannot pause now. Finish your turn.'];
  const decisionId = randomUUID();
  await ctx.store.append([
    {
      streamId: streamId.thread(t.id),
      event: {
        type: 'BoardDecisionRaised',
        payload: {
          threadId: t.id,
          decisionId,
          question: p.data.question,
          options: p.data.options.map((label, i) => ({ id: `o${i + 1}`, label })),
          round: cfg.round,
          askedByName: turn.speaker_name,
        },
      },
      actor: actorOf(turn),
      scope: sessionScope(t),
    },
    svc.configEvent(t, { stage: 'decision', chairFailures: 0, mentions: null }, actorOf(turn)),
    svc.systemMessage(t, `The Chair paused for a decision: ${p.data.question}`, { decisionId }),
  ]);
  return [
    true,
    {
      message:
        "The question is on the owner's screen. Finish your turn now: the session resumes when they decide.",
    },
  ];
}

async function converge(
  svc: BoardService,
  ctx: Ctx,
  t: Row,
  turn: Row,
  params: Record<string, unknown>,
): Promise<Reply> {
  const p = BoardConvergeParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      `usage: aom board converge --note "<what they agree on>" (${zodText(p.error.issues)})`,
    ];
  const cfg = parseBoardConfig(t.session_config);
  if (cfg.stage !== 'chair')
    return [false, undefined, 'Flag convergence before you choose the next speakers.'];
  if (cfg.dissentNext) return [true, { message: 'Already flagged: the next round is a dissent round.' }];
  await ctx.store.append([
    svc.configEvent(t, { dissentNext: true, dissentNote: p.data.note }, actorOf(turn)),
    svc.systemMessage(
      t,
      `The Chair noticed the room agreeing early (${p.data.note}). The next round is a steel-man and dissent round.`,
      {
        converged: true,
      },
    ),
  ]);
  return [
    true,
    {
      message:
        'Flagged. The next round will be a dissent round: now choose the speakers with `aom board next`.',
    },
  ];
}

async function disagreement(ctx: Ctx, t: Row, turn: Row, params: Record<string, unknown>): Promise<Reply> {
  const p = BoardDisagreementParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      `usage: aom board disagreement add --topic "<what>" --position "<Name>|<their view>" --position "<Name>|<their view>" (${zodText(p.error.issues)})`,
    ];
  const positions = p.data.positions.map(parsePosition);
  if (positions.some((x) => !x)) return [false, undefined, 'each --position is "<Name>|<their view>"'];
  // `who` must be someone in the room: the stored name is the roster's, never free text from the model
  const roster = await castOf(ctx.pool, t.id);
  const canonical: Array<{ who: string; position: string }> = [];
  for (const x of positions as Array<{ who: string; position: string }>) {
    const key = x.who.trim().toLowerCase();
    const hit = roster.find(
      (c) =>
        c.display_name.toLowerCase() === key || participantSlug(c.display_name) === participantSlug(x.who),
    );
    if (!hit)
      return [
        false,
        undefined,
        `"${x.who.slice(0, 60)}" is not in the room. Use one of: ${roster.map((c) => c.display_name).join(', ')}`,
      ];
    canonical.push({ who: hit.display_name, position: x.position });
  }
  const dup = await one(
    ctx.pool,
    `SELECT 1 FROM board_disagreements WHERE thread_id=$1 AND lower(topic)=lower($2)`,
    [t.id, p.data.topic],
  );
  if (dup) return [true, { message: 'That disagreement is already recorded.' }];
  await ctx.store.append([
    {
      streamId: streamId.thread(t.id),
      event: {
        type: 'BoardDisagreementRecorded',
        payload: {
          threadId: t.id,
          disagreementId: randomUUID(),
          topic: p.data.topic,
          positions: canonical,
          round: turn.round ?? null,
          by: authorOf(turn),
        },
      },
      actor: actorOf(turn),
      scope: sessionScope(t),
    },
  ]);
  return [true, { message: 'Recorded as an open disagreement. It stays in the minutes.' }];
}

async function cast(
  svc: BoardService,
  ctx: Ctx,
  t: Row,
  turn: Row,
  params: Record<string, unknown>,
): Promise<Reply> {
  const p = BoardCastParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      `usage: aom board cast --persona <key> --why "<why>" | --name "<Name>" --brief "<one line>" (${zodText(p.error.issues)})`,
    ];
  const cfg = parseBoardConfig(t.session_config);
  if (cfg.suggestions.length >= 8) return [false, undefined, 'That is enough voices: finish your turn.'];
  const id = `s${cfg.suggestions.length + 1}`;
  let s: (typeof cfg.suggestions)[number];
  if (p.data.persona) {
    if (['chair', 'analyst'].includes(p.data.persona))
      return [false, undefined, 'The chair and the analyst do not take a seat in the cast.'];
    const persona = await resolvePersona(ctx.pool, t.org_id, p.data.persona);
    if (!persona) return [false, undefined, `persona "${p.data.persona}" is not in the registry`];
    if (cfg.suggestions.some((x) => x.personaKey === persona.key))
      return [true, { message: 'Already suggested.' }];
    s = {
      id,
      type: 'persona',
      personaKey: persona.key,
      name: persona.name,
      why: p.data.why,
      ...(p.data.seat ? { seat: p.data.seat } : {}),
    };
  } else {
    s = {
      id,
      type: 'adhoc',
      name: p.data.name as string,
      brief: p.data.brief as string,
      why: p.data.why,
      ...(p.data.seat ? { seat: p.data.seat } : {}),
    };
    if (cfg.suggestions.some((x) => x.name.toLowerCase() === s.name.toLowerCase()))
      return [true, { message: 'Already suggested.' }];
  }
  await ctx.store.append([svc.configEvent(t, { suggestions: [...cfg.suggestions, s] }, actorOf(turn))]);
  return [true, { message: `Suggested ${s.name}.` }];
}

async function minutes(
  svc: BoardService,
  t: Row,
  turn: Row,
  params: Record<string, unknown>,
): Promise<Reply> {
  const p = BoardMinutesParamsSchema.safeParse(params);
  if (!p.success)
    return [false, undefined, `usage: aom board minutes --content "<markdown>" (${zodText(p.error.issues)})`];
  const doc = await svc.saveMinutes(t, p.data.content, authorOf(turn), actorOf(turn), turn.id);
  return [
    true,
    {
      docId: doc.docId,
      version: doc.version,
      message: `Saved the minutes (version ${doc.version}). Finish your turn now.`,
    },
  ];
}
