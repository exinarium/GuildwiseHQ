import { decisionFilePath, projectVaultFolder, renderDecisionFile } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import type { StoredEvent } from '../eventstore/types.ts';
import { enqueueVaultWrite } from './vaults.ts';

export interface DecisionRecord {
  deskItemId: string;
  projectId: string;
  question: string;
  answer: string;
  answerOptionLabel?: string;
  askedBy: string;
  cardRef?: string;
  ledgerEntryId?: string;
  answeredAt: Date;
  answeredBy?: string;
}

export type DecisionWriteResult =
  | { queued: true; path: string; workstationId: string; commandId: string }
  | { queued: false; reason: 'no_vault' | 'no_workstation' | 'project_not_found' };

/**
 * Writes the ADR-style decision file of an answered question into the project's domain vault
 * (`projects/<name>/decisions/<date>-<slug>.md`, docs/ARCHITECTURE.md section 16.4) through a durable `vault.write`
 * command; the runner commits and pushes it. The vault is the project vault if the project has one, else the
 * owner's vault of the project's domain. No registered vault: nothing is written (the ledger entry still exists).
 */
export async function writeDecisionFile(ctx: Ctx, rec: DecisionRecord): Promise<DecisionWriteResult> {
  const p = await one(ctx.pool, 'SELECT id, org_id, key, domain, vault_folder FROM projects WHERE id=$1', [
    rec.projectId,
  ]);
  if (!p) return { queued: false, reason: 'project_not_found' };
  const vault =
    (await one(ctx.pool, 'SELECT id FROM vaults WHERE project_id=$1', [p.id])) ??
    (await one(ctx.pool, 'SELECT id FROM vaults WHERE org_id=$1 AND kind=$2 AND project_id IS NULL', [
      p.org_id,
      p.domain,
    ]));
  if (!vault) return { queued: false, reason: 'no_vault' };
  const folder = projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder });
  const path = decisionFilePath(folder, rec);
  const r = await enqueueVaultWrite(ctx, ctx.pool, vault.id, {
    path,
    mode: 'create',
    content: renderDecisionFile(rec),
    commitMessage: `aom: decision ${rec.cardRef ? `${rec.cardRef} ` : ''}${rec.question.replace(/\s+/g, ' ').slice(0, 60)}`,
  });
  if (!r.queued || !r.workstationId || !r.commandId) return { queued: false, reason: 'no_workstation' };
  await ctx.services.gateway.deliverPending(r.workstationId);
  return { queued: true, path, workstationId: r.workstationId, commandId: r.commandId };
}

/**
 * Appends a standing order added on the desk to the vault: `projects/<name>/standing-orders.md` for a project order,
 * the work vault's `standing-orders.md` for an organization-wide one (docs/ARCHITECTURE.md section 16.4).
 *
 * TODO(M2 integration): call from the M2 ledger command / `LedgerEntryAdded` handler when `scope = 'standing_order'`.
 */
export async function appendStandingOrder(
  ctx: Ctx,
  input: { orgId: string; projectId?: string | null; title: string; body: string; at?: Date },
): Promise<DecisionWriteResult> {
  let vaultId: string | undefined;
  let path = 'standing-orders.md';
  if (input.projectId) {
    const p = await one(ctx.pool, 'SELECT id, org_id, key, domain, vault_folder FROM projects WHERE id=$1', [
      input.projectId,
    ]);
    if (!p) return { queued: false, reason: 'project_not_found' };
    vaultId = (
      (await one(ctx.pool, 'SELECT id FROM vaults WHERE project_id=$1', [p.id])) ??
      (await one(ctx.pool, 'SELECT id FROM vaults WHERE org_id=$1 AND kind=$2 AND project_id IS NULL', [
        p.org_id,
        p.domain,
      ]))
    )?.id;
    path = `${projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder })}/standing-orders.md`;
  } else {
    vaultId = (
      await one(ctx.pool, `SELECT id FROM vaults WHERE org_id=$1 AND kind='work' AND project_id IS NULL`, [
        input.orgId,
      ])
    )?.id;
  }
  if (!vaultId) return { queued: false, reason: 'no_vault' };
  const day = (input.at ?? ctx.clock.now()).toISOString().slice(0, 10);
  const r = await enqueueVaultWrite(ctx, ctx.pool, vaultId, {
    path,
    mode: 'append',
    content: `\n## ${input.title.trim()}\n\n${input.body.trim()}\n\n_Added ${day}._\n`,
    commitMessage: `aom: standing order ${input.title.replace(/\s+/g, ' ').slice(0, 60)}`,
  });
  if (!r.queued || !r.workstationId || !r.commandId) return { queued: false, reason: 'no_workstation' };
  await ctx.services.gateway.deliverPending(r.workstationId);
  return { queued: true, path, workstationId: r.workstationId, commandId: r.commandId };
}

/**
 * TODO(M2 integration): `QuestionAnswered` and the `desk_items` table belong to M2 and do not exist on this branch.
 * This hook subscribes to the event store and, when M2's `QuestionAnswered` arrives, reads the desk item (columns per
 * docs/ARCHITECTURE.md section 4.2: id, project_id, card_id, title, body, doing, options, asked_by_role, ...) and
 * calls `writeDecisionFile`. It is registered in app.ts (one line) and is inert here: without the table the lookup
 * fails and is logged at debug level. The coordinator should check the column names against M2's migration 0200.
 */
export function registerDecisionHook(ctx: Ctx): () => void {
  return ctx.store.subscribe(async (e: StoredEvent) => {
    if ((e.event.type as string) !== 'QuestionAnswered') return;
    const p = e.event.payload as unknown as {
      deskItemId: string;
      answer: string;
      answerOption?: string;
      ledgerEntryId?: string;
      answeredBy?: { userId?: string };
    };
    try {
      const item = await one(
        ctx.pool,
        `SELECT d.project_id, d.card_id, d.title, d.body, d.options, d.asked_by_role, c.ref AS card_ref,
                a.name AS agent_name, u.display_name AS answered_by_name
           FROM desk_items d LEFT JOIN cards c ON c.id = d.card_id LEFT JOIN agents a ON a.id = d.asked_by_agent_id
           LEFT JOIN users u ON u.id = $2
          WHERE d.id = $1`,
        [p.deskItemId, p.answeredBy?.userId ?? null],
      );
      if (!item?.project_id) return;
      const option = (item.options as Array<{ id: string; label: string }> | null)?.find(
        (o) => o.id === p.answerOption,
      );
      await writeDecisionFile(ctx, {
        deskItemId: p.deskItemId,
        projectId: item.project_id,
        question: item.body?.trim() ? item.body : item.title,
        answer: p.answer,
        answerOptionLabel: option?.label,
        askedBy: item.agent_name
          ? `${item.agent_name}${item.asked_by_role ? ` (${item.asked_by_role})` : ''}`
          : 'an agent',
        cardRef: item.card_ref ?? undefined,
        ledgerEntryId: p.ledgerEntryId,
        answeredAt: e.createdAt,
        answeredBy: item.answered_by_name ?? undefined,
      });
    } catch (err) {
      ctx.log.debug({ err }, 'decision file hook skipped (M2 desk not wired yet?)');
    }
  });
}
