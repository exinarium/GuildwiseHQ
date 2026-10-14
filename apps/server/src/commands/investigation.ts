import { randomUUID } from 'node:crypto';
import {
  INVESTIGATIONS_SECTION_ID,
  type InvestigationIndexEntry,
  InvestigationRecordParamsSchema,
  PROJECT_FILE,
  PROJECT_FILE_HEADER,
  renderInvestigationsIndex,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { agentActor, cardMessage, projectScope } from './common.ts';
import { projectVault } from './decisions.ts';
import type { RpcReply } from './intake.ts';
import { enqueueVaultWrite } from './vaults.ts';

/** Tag of the ledger entry that records an investigation-only card's result. */
export const INVESTIGATION_TAG = 'investigation';

/** Has the result of this investigation-only card been recorded (a live ledger entry tagged `investigation`)? */
export async function investigationRecorded(db: Queryable, cardId: string): Promise<boolean> {
  return !!(await one(
    db,
    `SELECT 1 FROM ledger_entries WHERE card_id=$1 AND $2 = ANY(tags) AND superseded_by IS NULL LIMIT 1`,
    [cardId, INVESTIGATION_TAG],
  ));
}

/** The investigations of a project as `PROJECT.md` lists them: the recorded ledger entries with their reports. */
export async function investigationIndexEntries(
  db: Queryable,
  projectId: string,
): Promise<InvestigationIndexEntry[]> {
  const list = await rows(
    db,
    `SELECT l.title, l.body, l.scope, l.created_at, c.ref, c.investigation
       FROM ledger_entries l JOIN cards c ON c.id = l.card_id
      WHERE l.project_id=$1 AND $2 = ANY(l.tags) AND l.superseded_by IS NULL
      ORDER BY l.created_at, l.id`,
    [projectId, INVESTIGATION_TAG],
  );
  return list.map((r) => {
    const inv = (r.investigation ?? {}) as { reportPath?: string; location?: 'repo' | 'vault' };
    return {
      cardRef: r.ref,
      title: r.title,
      reportPath: inv.reportPath ?? '',
      location: inv.location ?? 'repo',
      recordedAt: iso(r.created_at) as string,
      decision: r.scope === 'decision',
      summary: String(r.body).split('\n\nReport:')[0] ?? '',
    };
  });
}

/**
 * `aom investigation record` (the BA's Finalize shift on an investigation-only card): writes the result into the ledger
 * (a feature entry, or a decision with `--decision`, tagged `investigation`, linked to the card and its report) and
 * queues the project's `PROJECT.md` managed section `investigations` (a list of every recorded investigation, versioned
 * by event sequence like the research index). Recording again replaces the earlier entry. Not terminal: the BA then
 * finalizes. Refused unless the card is investigation-only, in Finalize and held by this shift.
 */
export async function investigationRecordRpc(
  ctx: Ctx,
  shift: Row,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const p = InvestigationRecordParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      `usage: aom investigation record --title "<what was investigated>" --summary-file <summary.md> [--decision] (${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`,
    ];
  if (shift.kind !== 'card' || !shift.card_id)
    return [false, undefined, 'recording an investigation is part of the Finalize shift of a card'];
  const out = await withAppendTx(
    ctx.pool,
    async (tx): Promise<{ reply: RpcReply; workstationId?: string }> => {
      const fail = (error: string): { reply: RpcReply } => ({ reply: [false, undefined, error] });
      const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [shift.card_id]);
      if (!card) return fail('card not found');
      if (card.claim_shift_id !== shift.id)
        return fail(`this shift no longer holds the claim on ${card.ref}`);
      if (!card.investigation_only)
        return fail(`${card.ref} is not an investigation-only card: there is nothing to record`);
      if (card.stage !== 'finalize')
        return fail(`${card.ref} is in ${card.stage}: record the investigation at Finalize`);
      if (!card.investigation)
        return fail(`${card.ref} has no investigation report yet: the architect has not reported`);
      const inv = card.investigation as { reportPath: string; location: 'repo' | 'vault'; summary: string };
      const old = await one<{ id: string }>(
        tx,
        `SELECT id FROM ledger_entries WHERE card_id=$1 AND $2 = ANY(tags) AND superseded_by IS NULL
        ORDER BY created_at DESC LIMIT 1`,
        [card.id, INVESTIGATION_TAG],
      );
      const entryId = randomUUID();
      const scope = projectScope(card.org_id, card.project_id);
      const actor = agentActor(shift.agent_id);
      const where = inv.location === 'vault' ? 'in the project vault' : 'in the repository';
      const stored = await ctx.store.append(
        [
          {
            streamId: streamId.ledger(entryId),
            event: {
              type: 'LedgerEntryAdded',
              payload: {
                entryId,
                scope: p.data.decision ? 'decision' : 'feature',
                projectId: card.project_id,
                cardId: card.id,
                title: p.data.title,
                body: `${p.data.summary}\n\nReport: ${inv.reportPath} (${where})`,
                tags: [INVESTIGATION_TAG, card.ref],
              },
            },
            actor,
            scope,
          },
          ...(old
            ? [
                {
                  streamId: streamId.ledger(old.id),
                  event: {
                    type: 'LedgerEntrySuperseded' as const,
                    payload: { entryId: old.id, supersededBy: entryId },
                  },
                  actor,
                  scope,
                },
              ]
            : []),
          cardMessage(
            card,
            { kind: 'agent', agentId: shift.agent_id },
            'comment',
            `Investigation recorded in the ledger${p.data.decision ? ' as a decision' : ''}: ${p.data.title}`,
          ),
        ],
        { tx },
      );
      // PROJECT.md: rebuilt from every recorded investigation, versioned by the sequence of this event.
      let workstationId: string | undefined;
      const target = await projectVault(tx, card.project_id);
      if (target?.vaultId) {
        const entries = await investigationIndexEntries(tx, card.project_id);
        const w = await enqueueVaultWrite(ctx, tx, target.vaultId, {
          path: `${target.folder}/${PROJECT_FILE}`,
          mode: 'section',
          section: { id: INVESTIGATIONS_SECTION_ID, version: Number(stored[0]?.seq ?? 0n) },
          content: renderInvestigationsIndex(entries, { folder: target.folder }),
          header: PROJECT_FILE_HEADER,
          commitMessage: `list the investigation ${card.ref} in PROJECT.md`,
        });
        if (w.queued) workstationId = w.workstationId;
      }
      return {
        reply: [
          true,
          {
            entryId,
            message: `Recorded in the ledger${target?.vaultId ? ' and queued for PROJECT.md' : ' (this project has no vault, so PROJECT.md is unchanged)'}. Finalize now: \`aom finalize\`.`,
          },
        ],
        ...(workstationId ? { workstationId } : {}),
      };
    },
  );
  if (out.workstationId) await ctx.services.gateway.deliverPending(out.workstationId).catch(() => undefined);
  return out.reply;
}
