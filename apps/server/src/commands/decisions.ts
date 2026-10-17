import { decisionFilePath, projectVaultFolder, renderDecisionFile } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
import type { StoredEvent } from '../eventstore/types.ts';
import { enqueueVaultWrite } from './vaults.ts';

export interface DecisionRecord {
  /** Overrides the computed path (the path recorded on the ledger entry when the question was answered). */
  path?: string;
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

/** The vault a project's files go to: the project vault if it has one, else the organization vault. */
export async function projectVault(db: Queryable, projectId: string) {
  const p = await one(db, 'SELECT id, org_id, key, vault_folder, vault_dir FROM projects WHERE id=$1', [
    projectId,
  ]);
  if (!p) return null;
  const vault =
    (await one(db, 'SELECT id FROM vaults WHERE project_id=$1', [p.id])) ??
    (await one(db, 'SELECT id FROM vaults WHERE org_id=$1 AND kind=$2 AND project_id IS NULL', [
      p.org_id,
      'org',
    ]));
  return {
    vaultId: vault?.id as string | undefined,
    folder: projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder, vaultDir: p.vault_dir }),
  };
}

/**
 * The vault path a ledger entry will be written to (recorded as `LedgerEntryAdded.vaultPath`), or undefined when
 * no vault exists for it: decisions and features go to `decisions/`, standing orders to `standing-orders.md`.
 */
export async function plannedVaultPath(
  db: Queryable,
  q: {
    scope: 'feature' | 'decision' | 'standing_order';
    orgId: string;
    projectId?: string | null;
    decision?: { deskItemId: string; question: string; answeredAt: Date };
  },
): Promise<string | undefined> {
  if (q.scope === 'standing_order') {
    if (q.projectId) {
      const t = await projectVault(db, q.projectId);
      return t?.vaultId ? `${t.folder}/standing-orders.md` : undefined;
    }
    const w = await one(db, `SELECT id FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`, [
      q.orgId,
    ]);
    return w ? 'standing-orders.md' : undefined;
  }
  if (!q.projectId || !q.decision) return undefined;
  const t = await projectVault(db, q.projectId);
  return t?.vaultId
    ? decisionFilePath(t.folder, q.decision as Parameters<typeof decisionFilePath>[1])
    : undefined;
}

export type DecisionWriteResult =
  | { queued: true; path: string; workstationId: string; commandId: string }
  | { queued: false; reason: 'no_vault' | 'no_workstation' | 'project_not_found' };

/**
 * Writes the ADR-style decision file of an answered question into the project's vault
 * (`projects/<name>/decisions/<date>-<slug>.md`, docs/ARCHITECTURE.md section 16.4) through a durable `vault.write`
 * command; the runner commits and pushes it. The vault is the project vault if the project has one, else the
 * organization vault. No registered vault: nothing is written (the ledger entry still exists).
 */
export async function writeDecisionFile(ctx: Ctx, rec: DecisionRecord): Promise<DecisionWriteResult> {
  const p = await one(ctx.pool, 'SELECT id, org_id, key, vault_folder, vault_dir FROM projects WHERE id=$1', [
    rec.projectId,
  ]);
  if (!p) return { queued: false, reason: 'project_not_found' };
  const vault =
    (await one(ctx.pool, 'SELECT id FROM vaults WHERE project_id=$1', [p.id])) ??
    (await one(ctx.pool, 'SELECT id FROM vaults WHERE org_id=$1 AND kind=$2 AND project_id IS NULL', [
      p.org_id,
      'org',
    ]));
  if (!vault) return { queued: false, reason: 'no_vault' };
  const folder = projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder, vaultDir: p.vault_dir });
  const path = rec.path ?? decisionFilePath(folder, rec);
  const r = await enqueueVaultWrite(ctx, ctx.pool, vault.id, {
    path,
    mode: 'create',
    content: renderDecisionFile(rec),
    commitMessage: `decision ${rec.cardRef ? `${rec.cardRef} ` : ''}${rec.question.replace(/\s+/g, ' ').slice(0, 60)}`,
  });
  if (!r.queued || !r.workstationId || !r.commandId) return { queued: false, reason: 'no_workstation' };
  await ctx.services.gateway.deliverPending(r.workstationId);
  return { queued: true, path, workstationId: r.workstationId, commandId: r.commandId };
}

/** The vault and file a scope's standing orders live in, or why there is none. */
async function appendTarget(
  ctx: Ctx,
  input: { orgId: string; projectId?: string | null },
): Promise<{ vaultId: string; path: string } | Extract<DecisionWriteResult, { queued: false }>> {
  let vaultId: string | undefined;
  let path = 'standing-orders.md';
  if (input.projectId) {
    const p = await one(
      ctx.pool,
      'SELECT id, org_id, key, vault_folder, vault_dir FROM projects WHERE id=$1',
      [input.projectId],
    );
    if (!p) return { queued: false, reason: 'project_not_found' };
    vaultId = (
      (await one(ctx.pool, 'SELECT id FROM vaults WHERE project_id=$1', [p.id])) ??
      (await one(ctx.pool, 'SELECT id FROM vaults WHERE org_id=$1 AND kind=$2 AND project_id IS NULL', [
        p.org_id,
        'org',
      ]))
    )?.id;
    path = `${projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder, vaultDir: p.vault_dir })}/standing-orders.md`;
  } else {
    vaultId = (
      await one(ctx.pool, `SELECT id FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`, [
        input.orgId,
      ])
    )?.id;
  }
  if (!vaultId) return { queued: false, reason: 'no_vault' };
  return { vaultId, path };
}

/**
 * Appends a standing order added on the desk to the vault: `projects/<name>/standing-orders.md` for a project order,
 * the organization vault's `standing-orders.md` for an organization-wide one (docs/ARCHITECTURE.md section 16.4).

 * Called by `registerDecisionHook` for every standing order added to the ledger.
 */
export async function appendStandingOrder(
  ctx: Ctx,
  input: { orgId: string; projectId?: string | null; title: string; body: string; at?: Date },
): Promise<DecisionWriteResult> {
  const target = await appendTarget(ctx, input);
  if ('queued' in target) return target;
  const { vaultId, path } = target;
  const day = (input.at ?? ctx.clock.now()).toISOString().slice(0, 10);
  const r = await enqueueVaultWrite(ctx, ctx.pool, vaultId, {
    path,
    mode: 'append',
    content: `\n## ${input.title.trim()}\n\n${input.body.trim()}\n\n_Added ${day}._\n`,
    commitMessage: `standing order ${input.title.replace(/\s+/g, ' ').slice(0, 60)}`,
  });
  if (!r.queued || !r.workstationId || !r.commandId) return { queued: false, reason: 'no_workstation' };
  await ctx.services.gateway.deliverPending(r.workstationId);
  return { queued: true, path, workstationId: r.workstationId, commandId: r.commandId };
}

/**
 * An edited standing order (backlog #74): the vault's `standing-orders.md` is a copy of the ledger, so it is written again
 * from the live standing orders of that scope (`replace` mode), instead of appending a second, contradicting version.
 * Same file, vault and commit path as `appendStandingOrder`.
 */
export async function rewriteStandingOrders(
  ctx: Ctx,
  input: { orgId: string; projectId?: string | null },
): Promise<DecisionWriteResult> {
  const first = await appendTarget(ctx, input);
  if ('queued' in first) return first;
  const live = await rows(
    ctx.pool,
    `SELECT title, body, created_at FROM ledger_entries
      WHERE org_id=$1 AND scope='standing_order' AND superseded_by IS NULL AND retired_at IS NULL AND project_id IS NOT DISTINCT FROM $2
      ORDER BY created_at, id`,
    [input.orgId, input.projectId ?? null],
  );
  const content = live
    .map(
      (o) =>
        `\n## ${String(o.title).trim()}\n\n${String(o.body).trim()}\n\n_Added ${(o.created_at as Date).toISOString().slice(0, 10)}._\n`,
    )
    .join('');
  const r = await enqueueVaultWrite(ctx, ctx.pool, first.vaultId, {
    path: first.path,
    mode: 'replace',
    content: content || '\n',
    commitMessage: 'standing orders edited',
  });
  if (!r.queued || !r.workstationId || !r.commandId) return { queued: false, reason: 'no_workstation' };
  await ctx.services.gateway.deliverPending(r.workstationId);
  return { queued: true, path: first.path, workstationId: r.workstationId, commandId: r.commandId };
}

/**
 * Subscribes to the event store: an answered question writes its decision file into the project's vault,
 * and a standing order added to the ledger is appended to the vault's `standing-orders.md`. Both go through the
 * durable `vault.write` command; with no vault registered nothing is written (the ledger entry still exists).
 */
export function registerDecisionHook(ctx: Ctx): () => void {
  return ctx.store.subscribe(async (e: StoredEvent) => {
    try {
      if (e.event.type === 'LedgerEntryAdded') {
        const p = e.event.payload;
        if (p.scope !== 'standing_order') return;
        await appendStandingOrder(ctx, {
          orgId: e.scope.orgId as string,
          projectId: p.projectId ?? null,
          title: p.title,
          body: p.body,
          at: e.createdAt,
        });
        return;
      }
      if (e.event.type === 'LedgerEntryEdited') {
        const row = await one(ctx.pool, `SELECT org_id, project_id, scope FROM ledger_entries WHERE id=$1`, [
          e.event.payload.entryId,
        ]);
        if (row?.scope === 'standing_order')
          await rewriteStandingOrders(ctx, { orgId: row.org_id, projectId: row.project_id });
        return;
      }
      if (e.event.type !== 'QuestionAnswered') return;
      const p = e.event.payload;
      // Only the manager's decisions become decision files; an agent's answer in the escalation chain does not.
      if (p.answeredBy.kind !== 'user') return;
      const item = await one(
        ctx.pool,
        `SELECT d.project_id, d.card_id, d.title, d.body, d.options, d.asked_by_role, c.ref AS card_ref,
                a.name AS agent_name, u.display_name AS answered_by_name,
                l.scope AS ledger_scope, l.vault_path AS ledger_path
           FROM desk_items d LEFT JOIN cards c ON c.id = d.card_id LEFT JOIN agents a ON a.id = d.asked_by_agent_id
           LEFT JOIN users u ON u.id = $2 LEFT JOIN ledger_entries l ON l.id = $3
          WHERE d.id = $1`,
        [p.deskItemId, p.answeredBy.userId ?? null, p.ledgerEntryId],
      );
      // Standing orders are written by the LedgerEntryAdded branch; items without a project have no domain vault.
      if (!item?.project_id || item.ledger_scope === 'standing_order') return;
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
        ...(item.ledger_path ? { path: item.ledger_path } : {}),
      });
    } catch (err) {
      ctx.log.warn({ err }, 'vault write hook failed');
    }
  });
}
