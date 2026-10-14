import {
  FEED_LIST_FILE,
  FEED_LIST_HEADER,
  type FeedVerdict,
  INTEREST_DOC_FILE,
  INTEREST_SECTION_ID,
  type InterestAgents,
  type InterestBody,
  RUNS_FILE,
  RUNS_HEADER,
  renderFeedEntries,
  renderInterestDoc,
  renderRunLine,
  renderTasteEntry,
  renderTasteRule,
  renderTasteSeedSection,
  TASTE_FILE,
  TASTE_HEADER,
  TASTE_SEED_SECTION_ID,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import type { StoredEvent } from '../eventstore/types.ts';
import { projectVault } from './decisions.ts';
import { enqueueVaultWrite } from './vaults.ts';

/**
 * Appends to a file of the project's vault folder (`projects/<name>/<file>`) through a durable `vault.write` command
 * (docs/ARCHITECTURE.md section 16.4). Append-only by construction: the runner only ever adds lines. No vault
 * registered for the project: nothing is written (the ratings and the running list still exist on the site).
 */
async function appendProjectFile(
  ctx: Ctx,
  projectId: string,
  file: string,
  content: string,
  header: string,
  commitMessage: string,
): Promise<boolean> {
  const target = await projectVault(ctx.pool, projectId);
  if (!target?.vaultId) return false;
  const r = await enqueueVaultWrite(ctx, ctx.pool, target.vaultId, {
    path: `${target.folder}/${file}`,
    mode: 'append',
    content,
    header,
    commitMessage,
  });
  if (r.queued && r.workstationId) await ctx.services.gateway.deliverPending(r.workstationId);
  return r.queued;
}

/**
 * Event hook for the interest files (docs/design/restructure.md section 6), in the vault folder of the backing project
 * (`interests/<slug>/`): a posted digest appends its items to the running list `feed.md` (oldest to newest, never
 * rewritten); a rating appends an explicit rule and its example to `taste.md` (of the interest the item's card belongs
 * to); the interest's own taste rules are the managed `seed` section; an approved taste-rule proposal appends the rule;
 * a finished run appends a line to `runs.md`; `INTEREST.md` mirrors the interest's settings. Curators read `taste.md` at
 * shift start.
 */
export function registerTasteHook(ctx: Ctx): () => void {
  return ctx.store.subscribe(async (e: StoredEvent) => {
    try {
      const ev = e.event;
      if (ev.type === 'DigestPosted') {
        if (ev.payload.items.length === 0) return;
        const card = await one(ctx.pool, 'SELECT ref FROM cards WHERE id=$1', [ev.payload.cardId]);
        await appendProjectFile(
          ctx,
          ev.payload.projectId,
          FEED_LIST_FILE,
          renderFeedEntries(ev.payload.items, e.createdAt),
          FEED_LIST_HEADER,
          `feed ${card?.ref ?? ''} ${ev.payload.items.length} item(s)`.replace(/\s+/g, ' '),
        );
      } else if (ev.type === 'InterestRunDone') {
        const run = await one(
          ctx.pool,
          `SELECT r.*, c.ref, i.project_id FROM interest_runs r JOIN cards c ON c.id = r.card_id
             JOIN interests i ON i.id = r.interest_id WHERE r.id=$1`,
          [ev.payload.runId],
        );
        if (!run?.project_id) return;
        await appendProjectFile(
          ctx,
          run.project_id,
          RUNS_FILE,
          renderRunLine({
            at: e.createdAt,
            kind: run.kind,
            trigger: run.trigger,
            status: run.status,
            found: run.found,
            published: run.published,
            cardRef: run.ref,
          }),
          RUNS_HEADER,
          `run ${run.ref}`,
        );
      } else if (ev.type === 'ResearchPublished') {
        const run = await one(
          ctx.pool,
          `SELECT r.*, c.ref, i.project_id FROM interest_runs r JOIN cards c ON c.id = r.card_id
             JOIN interests i ON i.id = r.interest_id WHERE r.card_id=$1`,
          [ev.payload.cardId],
        );
        if (!run?.project_id) return;
        await appendProjectFile(
          ctx,
          run.project_id,
          RUNS_FILE,
          renderRunLine({
            at: e.createdAt,
            kind: 'research',
            trigger: run.trigger,
            status: 'published',
            found: null,
            published: 1,
            cardRef: run.ref,
          }),
          RUNS_HEADER,
          `run ${run.ref}`,
        );
      } else if (ev.type === 'ItemRated') {
        const item = await one(
          ctx.pool,
          `SELECT d.kind, d.title, d.source, d.url, d.project_id, i.project_id AS interest_project
             FROM digest_items d JOIN cards c ON c.id = d.card_id LEFT JOIN interests i ON i.id = c.interest_id
            WHERE d.id=$1`,
          [ev.payload.itemId],
        );
        if (!item) return;
        // The rating goes to the folder of the interest's backing project (the item's own project for old history).
        await appendProjectFile(
          ctx,
          item.interest_project ?? item.project_id ?? ev.payload.projectId,
          TASTE_FILE,
          renderTasteEntry({
            verdict: ev.payload.verdict as FeedVerdict,
            kind: item.kind,
            title: item.title,
            source: item.source,
            url: item.url,
            reason: ev.payload.reason,
          }),
          TASTE_HEADER,
          `taste ${ev.payload.verdict} ${item.title}`.slice(0, 100),
        );
      } else if (ev.type === 'InterestTasteSet') {
        // The managed `seed` section of taste.md mirrors the rules built into the interest (the brief carries them either way).
        const i = await one(ctx.pool, 'SELECT project_id FROM interests WHERE id=$1', [
          ev.payload.interestId,
        ]);
        if (!i?.project_id) return;
        await writeSection(
          ctx,
          i.project_id,
          TASTE_FILE,
          TASTE_HEADER,
          TASTE_SEED_SECTION_ID,
          ev.payload.version,
          renderTasteSeedSection(ev.payload.rules.map((text) => ({ text, interestId: null }))),
          `taste rules v${ev.payload.version}`,
        );
      } else if (ev.type === 'InterestCreated' || ev.type === 'InterestUpdated') {
        const p = ev.payload as InterestBody;
        if (!p.projectId) return;
        await writeSection(
          ctx,
          p.projectId,
          INTEREST_DOC_FILE,
          '',
          INTEREST_SECTION_ID,
          Number(e.seq),
          renderInterestDoc({ ...p, agents: await agentNames(ctx, p.agents as InterestAgents) }),
          `interest ${p.name}`.slice(0, 100),
        );
      } else if (ev.type === 'DeskItemResolved' && ev.payload.resolution === 'approved') {
        const d = await one(
          ctx.pool,
          `SELECT project_id, body FROM desk_items WHERE id=$1 AND subkind='taste_rule'`,
          [ev.payload.deskItemId],
        );
        if (!d?.project_id) return;
        await appendProjectFile(
          ctx,
          d.project_id,
          TASTE_FILE,
          renderTasteRule(d.body),
          TASTE_HEADER,
          `taste rule ${d.body}`.replace(/\s+/g, ' ').slice(0, 100),
        );
      }
    } catch (err) {
      ctx.log.warn({ err }, 'feed vault write hook failed');
    }
  });
}

/** Agent ids to names, for the human-readable `INTEREST.md`. */
async function agentNames(ctx: Ctx, agents: InterestAgents): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [role, id] of Object.entries(agents ?? {})) {
    if (!id) continue;
    const a = await one(ctx.pool, 'SELECT name FROM agents WHERE id=$1', [id]);
    if (a) out[role] = a.name;
  }
  return out;
}

/** Writes a managed section of a file in the project's vault folder (a stale version is a no-op on the runner). */
async function writeSection(
  ctx: Ctx,
  projectId: string,
  file: string,
  header: string,
  sectionId: string,
  version: number,
  content: string,
  commitMessage: string,
): Promise<void> {
  const target = await projectVault(ctx.pool, projectId);
  if (!target?.vaultId) return;
  const r = await enqueueVaultWrite(ctx, ctx.pool, target.vaultId, {
    path: `${target.folder}/${file}`,
    mode: 'section',
    section: { id: sectionId, version },
    content,
    header,
    commitMessage,
  });
  if (r.queued && r.workstationId) await ctx.services.gateway.deliverPending(r.workstationId);
}
