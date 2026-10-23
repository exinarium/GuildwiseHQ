import { randomUUID } from 'node:crypto';
import {
  type DiscoveryConfig,
  type PanelSection,
  parseCheckItem,
  parseDiscoveryConfig,
  renderPanel,
  renderQa,
  SessionAnswerParamsSchema,
  SessionAskParamsSchema,
  SessionDraftParamsSchema,
  SessionNoteParamsSchema,
  SessionPhaseParamsSchema,
  SessionProposeParamsSchema,
  type SessionRpcMethod,
  DISCOVERY_PURPOSE_VERBS,
  SessionValidateParamsSchema,
  streamId,
} from '@aom/shared';
import { SYSTEM_ACTOR } from '../commands/common.ts';
import { scopeOfDoc, versionEvent } from '../commands/documents.ts';
import { sessionScope } from '../commands/sessions.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import type { DiscoveryService } from './discovery.ts';
import { listNotes, listQuestions } from './discovery-state.ts';

/** `[ok, result, error]`, as every rpc handler of the gateway answers. */
type Reply = [boolean, unknown?, string?];

const zodText = (issues: Array<{ path: PropertyKey[]; message: string }>): string =>
  issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');

const PURPOSE_VERBS = DISCOVERY_PURPOSE_VERBS;

/**
 * The server side of `aom session ...` for a discovery session turn. The caller proved the turn (its id is the chat id the
 * runner scopes the IPC token to) is running on the calling workstation; which verbs a turn may use follows from what the
 * turn is for (`session_turns.meta.purpose`): the facilitator drives the session, the CEO only proposes an answer to the
 * open question and may add one opinion to the panel. Nothing here applies a proposal: only the owner does.
 */
export async function sessionVerb(
  svc: DiscoveryService,
  ctx: Ctx,
  turn: Row,
  method: SessionRpcMethod,
  params: Record<string, unknown>,
): Promise<Reply> {
  const verb = method.slice('session.'.length);
  const purpose = (turn.meta as { purpose?: string } | null)?.purpose;
  if (!purpose)
    return [
      false,
      undefined,
      'this turn has no part in the discovery flow: only `aom skill` and `aom ledger search` are available',
    ];
  if (!PURPOSE_VERBS[purpose]?.includes(verb))
    return [false, undefined, `\`aom session ${verb}\` is not available in this turn`];
  const t = await one(
    ctx.pool,
    `SELECT * FROM threads WHERE id=$1 AND kind='discovery' AND deleted_at IS NULL`,
    [turn.thread_id],
  );
  if (!t) return [false, undefined, 'the session no longer exists'];
  return svc.serialized(t.id, async () => {
    const fresh = (await one(ctx.pool, 'SELECT * FROM threads WHERE id=$1', [t.id])) as Row;
    const cfg = parseDiscoveryConfig(fresh.session_config);
    try {
      switch (verb) {
        case 'show':
          return await show(ctx, fresh);
        case 'ask':
          return await ask(ctx, svc, fresh, cfg, turn, params);
        case 'answer':
          return await answer(ctx, svc, fresh, turn, params);
        case 'note':
          return await note(ctx, svc, fresh, turn, purpose, params);
        case 'propose':
          return await propose(ctx, fresh, turn, params);
        case 'phase':
          return await phase(ctx, fresh, cfg, turn, params);
        case 'draft':
          return await draft(ctx, svc, fresh, cfg, turn, params);
        case 'validate':
          return await validate(ctx, fresh, cfg, params);
        default:
          return [false, undefined, `unknown verb ${verb}`];
      }
    } catch (err) {
      return [false, undefined, err instanceof Error ? err.message : String(err)];
    }
  });
}

const actorOf = (turn: Row): AppendInput['actor'] =>
  turn.agent_id
    ? { kind: 'agent', id: turn.agent_id }
    : { kind: 'runner', id: turn.workstation_id ?? SYSTEM_ACTOR.id };
const authorOf = (turn: Row) => ({
  kind: turn.agent_id ? ('agent' as const) : ('persona' as const),
  id: (turn.agent_id ?? turn.persona_key ?? null) as string | null,
  name: turn.speaker_name as string,
});

async function show(ctx: Ctx, t: Row): Promise<Reply> {
  const [q, n] = await Promise.all([listQuestions(ctx.pool, t.id), listNotes(ctx.pool, t.id)]);
  const text = [
    '## Questions and answers',
    renderQa(
      q.map((x) => ({
        id: x.id,
        question: x.question,
        status: x.status,
        phase: x.phase,
        options: x.options,
        answer: x.answer,
        proposed: x.proposed
          ? { text: x.proposed.text, optionId: x.proposed.optionId, byName: x.proposed.byName }
          : null,
      })),
    ),
    '## Panel',
    renderPanel(n.map((x) => ({ id: x.id, section: x.section, text: x.text, byName: x.byName }))),
  ].join('\n');
  return [true, { text }];
}

async function ask(
  ctx: Ctx,
  _svc: DiscoveryService,
  t: Row,
  cfg: DiscoveryConfig,
  turn: Row,
  params: Record<string, unknown>,
): Promise<Reply> {
  const p = SessionAskParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      `usage: aom session ask --question "<q>" --option "<a>" ... (${zodText(p.error.issues)})`,
    ];
  const already = await one(ctx.pool, 'SELECT 1 FROM discovery_questions WHERE turn_id=$1', [turn.id]);
  if (already)
    return [
      false,
      undefined,
      'You already asked a question in this turn. One question at a time: finish your turn and wait for the answer.',
    ];
  const questionId = randomUUID();
  await ctx.store.append([
    {
      streamId: streamId.thread(t.id),
      event: {
        type: 'DiscoveryQuestionAsked',
        payload: {
          threadId: t.id,
          questionId,
          turnId: turn.id,
          askedByName: turn.speaker_name,
          question: p.data.question,
          ...(p.data.why ? { why: p.data.why } : {}),
          options: p.data.options.map((label, i) => ({ id: `o${i + 1}`, label })),
          allowFreeText: p.data.allowFreeText || p.data.options.length === 0,
          phase: cfg.phase,
        },
      },
      actor: actorOf(turn),
      scope: sessionScope(t),
    },
  ]);
  return [
    true,
    {
      questionId,
      message:
        "The question is on the owner's screen. Finish your turn now: the answer comes in your next turn.",
    },
  ];
}

/** The CEO proposes an answer to the open question. A proposal, never an answer. */
async function answer(
  ctx: Ctx,
  svc: DiscoveryService,
  t: Row,
  turn: Row,
  params: Record<string, unknown>,
): Promise<Reply> {
  const p = SessionAnswerParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      `usage: aom session answer [--option <id>] [--text "<answer>"] --why "<reason>" (${zodText(p.error.issues)})`,
    ];
  const meta = turn.meta as { questionId?: string; mode?: 'joint' | 'ceo_prep' };
  const q = meta.questionId
    ? await one(ctx.pool, 'SELECT * FROM discovery_questions WHERE id=$1 AND thread_id=$2', [
        meta.questionId,
        t.id,
      ])
    : undefined;
  if (!q) return [false, undefined, 'the question is gone'];
  if (q.status !== 'open')
    return [false, undefined, 'The owner already answered that question; nothing to propose.'];
  if (q.proposed) return [false, undefined, 'You already proposed an answer to this question.'];
  const options = (q.options ?? []) as Array<{ id: string; label: string }>;
  const opt = p.data.option ? options.find((o) => o.id === p.data.option) : undefined;
  if (p.data.option && !opt)
    return [
      false,
      undefined,
      `unknown option ${p.data.option} (options: ${options.map((o) => o.id).join(', ') || 'none'})`,
    ];
  const text = p.data.text?.trim() || opt?.label || '';
  if (!text) return [false, undefined, 'give --option <id> or --text "<answer>"'];
  await ctx.store.append([
    svc.proposedEvent(
      t,
      q.id,
      { text, ...(opt ? { optionId: opt.id } : {}), ...(p.data.why ? { why: p.data.why } : {}) },
      turn,
      meta.mode ?? 'joint',
    ),
  ]);
  return [
    true,
    { message: "Proposal recorded as the CEO's suggestion. The owner decides. Finish your turn." },
  ];
}

async function note(
  ctx: Ctx,
  svc: DiscoveryService,
  t: Row,
  turn: Row,
  purpose: string,
  params: Record<string, unknown>,
): Promise<Reply> {
  const p = SessionNoteParamsSchema.safeParse(params);
  if (!p.success)
    return [false, undefined, `usage: aom session note add|update|remove ... (${zodText(p.error.issues)})`];
  const by = authorOf(turn);
  if (p.data.op === 'add') {
    if (purpose === 'ceo_answer') {
      const n = await one(
        ctx.pool,
        `SELECT count(*)::int AS n FROM discovery_notes WHERE thread_id=$1 AND by_id=$2 AND removed_at IS NULL AND created_at > now() - interval '1 minute'`,
        [t.id, by.id],
      );
      if ((n?.n ?? 0) >= 2) return [false, undefined, 'You may add one opinion per turn.'];
    }
    const ev = svc.noteEvent(t, p.data.section as PanelSection, p.data.text, by);
    await ctx.store.append([ev]);
    const id = (ev.event.payload as { noteId: string }).noteId;
    return [true, { id: id.slice(0, 8), message: `Added to ${p.data.section}.` }];
  }
  if (purpose !== 'facilitator') return [false, undefined, 'only the facilitator changes or removes notes'];
  const found = await ctx.pool.query(
    `SELECT id FROM discovery_notes WHERE thread_id=$1 AND removed_at IS NULL AND id::text LIKE $2 || '%'`,
    [t.id, p.data.id],
  );
  if (found.rows.length !== 1)
    return [
      false,
      undefined,
      found.rows.length
        ? 'that id matches several notes: use more characters'
        : `no note ${p.data.id} (see \`aom session show\`)`,
    ];
  const noteId = found.rows[0].id as string;
  await ctx.store.append([
    p.data.op === 'update'
      ? {
          streamId: streamId.thread(t.id),
          event: {
            type: 'DiscoveryNoteUpdated',
            payload: {
              threadId: t.id,
              noteId,
              ...(p.data.text ? { text: p.data.text } : {}),
              ...(p.data.section ? { section: p.data.section } : {}),
              by,
            },
          },
          actor: actorOf(turn),
          scope: sessionScope(t),
        }
      : {
          streamId: streamId.thread(t.id),
          event: { type: 'DiscoveryNoteRemoved', payload: { threadId: t.id, noteId } },
          actor: actorOf(turn),
          scope: sessionScope(t),
        },
  ]);
  return [true, { message: p.data.op === 'update' ? 'Note updated.' : 'Note removed.' }];
}

async function propose(ctx: Ctx, t: Row, turn: Row, params: Record<string, unknown>): Promise<Reply> {
  const p = SessionProposeParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      `usage: aom session propose --title "<t>" --change "<c>" --rationale "<why>" [--doc <id> --section "<heading>"] (${zodText(p.error.issues)})`,
    ];
  if (p.data.doc) {
    const d = await one(
      ctx.pool,
      'SELECT id, status, source_thread_ids FROM documents WHERE id=$1 AND org_id=$2',
      [p.data.doc, t.org_id],
    );
    if (!d || !((d.source_thread_ids as string[]) ?? []).includes(t.id))
      return [false, undefined, 'that document is not part of this session'];
    if (d.status !== 'draft' && d.status !== 'in_review')
      return [
        false,
        undefined,
        `that document is ${String(d.status).replace('_', ' ')}: it cannot take changes`,
      ];
  }
  const proposalId = randomUUID();
  await ctx.store.append([
    {
      streamId: streamId.thread(t.id),
      event: {
        type: 'DiscoveryProposalRaised',
        payload: {
          threadId: t.id,
          proposalId,
          turnId: turn.id,
          title: p.data.title,
          change: p.data.change,
          rationale: p.data.rationale,
          ...(p.data.doc ? { docId: p.data.doc } : {}),
          ...(p.data.section ? { section: p.data.section } : {}),
          askedByName: turn.speaker_name,
        },
      },
      actor: actorOf(turn),
      scope: sessionScope(t),
    },
  ]);
  return [
    true,
    {
      proposalId,
      message:
        'Proposal shown to the owner. Nothing changes until they choose Apply. Carry on, or finish your turn.',
    },
  ];
}

async function phase(
  ctx: Ctx,
  t: Row,
  cfg: DiscoveryConfig,
  turn: Row,
  params: Record<string, unknown>,
): Promise<Reply> {
  const p = SessionPhaseParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      'usage: aom session phase --to frame|diverge|converge|stress_test|capture [--reason "<why>"]',
    ];
  if (p.data.to === cfg.phase) return [true, { message: `Already in ${cfg.phase}.` }];
  await ctx.store.append([
    {
      streamId: streamId.thread(t.id),
      event: {
        type: 'DiscoveryPhaseChanged',
        payload: {
          threadId: t.id,
          from: cfg.phase,
          to: p.data.to,
          by: authorOf(turn),
          ...(p.data.reason ? { reason: p.data.reason } : {}),
        },
      },
      actor: actorOf(turn),
      scope: sessionScope(t),
    },
  ]);
  return [true, { message: `Phase is now ${p.data.to}. The owner can override it.` }];
}

async function draft(
  ctx: Ctx,
  svc: DiscoveryService,
  t: Row,
  cfg: DiscoveryConfig,
  turn: Row,
  params: Record<string, unknown>,
): Promise<Reply> {
  const p = SessionDraftParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      `usage: aom session draft --kind brief|prd --content "<markdown>" (${zodText(p.error.issues)})`,
    ];
  const kind = p.data.kind;
  const existingId = kind === 'prd' ? cfg.prdDocId : cfg.briefDocId;
  const savedBy = authorOf(turn);
  const scope = (d: { org_id: string; project_id: string | null }) => scopeOfDoc(d);
  if (existingId) {
    const d = await one(ctx.pool, 'SELECT * FROM documents WHERE id=$1 AND org_id=$2 FOR UPDATE', [
      existingId,
      t.org_id,
    ]);
    if (d) {
      if (d.status !== 'draft' && d.status !== 'in_review')
        return [
          false,
          undefined,
          `The ${kind === 'prd' ? 'PRD' : 'brief'} is ${String(d.status).replace('_', ' ')}: ask the owner to reopen it before you change it.`,
        ];
      const cur = await one(
        ctx.pool,
        'SELECT content FROM document_versions WHERE document_id=$1 AND version=$2',
        [d.id, d.current_version],
      );
      if (cur?.content === p.data.content)
        return [
          true,
          {
            docId: d.id,
            version: d.current_version,
            message: 'No change: the document already has this text.',
          },
        ];
      await ctx.store.append([
        versionEvent(
          d.id,
          d.current_version + 1,
          p.data.content,
          { kind: savedBy.kind, id: savedBy.id },
          scope(d as never),
          actorOf(turn),
          {
            note: p.data.note,
            sourceThreadIds: [t.id],
          },
        ),
      ]);
      return [
        true,
        {
          docId: d.id,
          version: d.current_version + 1,
          message: `Saved version ${d.current_version + 1}. The owner sees it in the panel.`,
        },
      ];
    }
  }
  // First draft: create the document linked to this session.
  const { documentSlug } = await import('@aom/shared');
  const title = p.data.title ?? `${kind === 'prd' ? 'PRD' : 'Product brief'}: ${t.title}`.slice(0, 200);
  const base = documentSlug(title);
  let slug = base;
  for (
    let n = 2;
    await one(
      ctx.pool,
      'SELECT 1 FROM documents WHERE org_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND slug=$3',
      [t.org_id, t.project_id ?? null, slug],
    );
    n++
  )
    slug = `${base.slice(0, 56)}-${n}`;
  const docId = randomUUID();
  const sc = scope({ org_id: t.org_id, project_id: t.project_id ?? null });
  await ctx.store.append([
    {
      streamId: streamId.document(docId),
      event: {
        type: 'DocumentCreated',
        payload: {
          docId,
          orgId: t.org_id,
          ...(t.project_id ? { projectId: t.project_id } : {}),
          kind,
          title,
          slug,
          createdBy: t.created_by,
          sourceThreadIds: [t.id],
        },
      },
      actor: actorOf(turn),
      scope: sc,
    },
    versionEvent(docId, 1, p.data.content, { kind: savedBy.kind, id: savedBy.id }, sc, actorOf(turn), {
      note: p.data.note,
    }),
    svc.configEvent(t, kind === 'prd' ? { prdDocId: docId } : { briefDocId: docId }, actorOf(turn)),
  ]);
  return [
    true,
    {
      docId,
      version: 1,
      message: `Created the ${kind === 'prd' ? 'PRD' : 'brief'} (version 1). The owner sees it in the panel.`,
    },
  ];
}

async function validate(
  ctx: Ctx,
  t: Row,
  cfg: DiscoveryConfig,
  params: Record<string, unknown>,
): Promise<Reply> {
  const p = SessionValidateParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      `usage: aom session validate --summary "<verdict>" --check "<criterion>|pass|fail|n/a|<note>" ... (${zodText(p.error.issues)})`,
    ];
  if (!cfg.prdDocId) return [false, undefined, 'there is no PRD yet: draft it first'];
  const items = p.data.items.map(parseCheckItem);
  if (items.some((i) => !i)) return [false, undefined, 'each --check is "<criterion>|pass|fail|n/a|<note>"'];
  const d = await one(ctx.pool, 'SELECT current_version FROM documents WHERE id=$1', [cfg.prdDocId]);
  const result = {
    docId: cfg.prdDocId,
    version: d?.current_version ?? 1,
    summary: p.data.summary,
    at: ctx.clock.now().toISOString(),
    items: items as NonNullable<(typeof items)[number]>[],
  };
  await ctx.store.append([
    {
      streamId: streamId.thread(t.id),
      event: { type: 'SessionThreadUpdated', payload: { threadId: t.id, config: { prdValidation: result } } },
      actor: SYSTEM_ACTOR,
      scope: sessionScope(t),
    },
  ]);
  const failed = result.items.filter((i) => i.status === 'fail').length;
  return [
    true,
    {
      message: `Recorded ${result.items.length} checks (${failed} failed). The owner sees the result beside the PRD.`,
    },
  ];
}
