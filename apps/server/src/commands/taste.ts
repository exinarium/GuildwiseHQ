import {
  FEED_LIST_FILE,
  FEED_LIST_HEADER,
  type FeedVerdict,
  renderFeedEntries,
  renderTasteEntry,
  renderTasteRule,
  renderTasteSeedSection,
  TASTE_FILE,
  TASTE_HEADER,
  TASTE_SEED_SECTION_ID,
  type TasteSeedLine,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
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
 * Event hook for the feed files: a posted digest appends its items to the running list `feed.md` (oldest to newest,
 * never rewritten); a rating appends an explicit rule and its example to `taste.md`; an approved taste-rule proposal
 * appends the rule. Curators read `taste.md` at shift start.
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
          `aom: feed ${card?.ref ?? ''} ${ev.payload.items.length} item(s)`.replace(/\s+/g, ' '),
        );
      } else if (ev.type === 'ItemRated') {
        const item = await one(ctx.pool, 'SELECT kind, title, source, url FROM digest_items WHERE id=$1', [
          ev.payload.itemId,
        ]);
        if (!item) return;
        await appendProjectFile(
          ctx,
          ev.payload.projectId,
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
          `aom: taste ${ev.payload.verdict} ${item.title}`.slice(0, 100),
        );
      } else if (ev.type === 'TasteSeedSet') {
        // The managed `seed` section of taste.md mirrors the explicit rules (the brief carries them either way).
        const target = await projectVault(ctx.pool, ev.payload.projectId);
        if (!target?.vaultId) return;
        const names = Object.fromEntries(
          (
            await rows<{ id: string; name: string }>(
              ctx.pool,
              'SELECT id, name FROM interests WHERE feed_project_id=$1',
              [ev.payload.projectId],
            )
          ).map((r) => [r.id, r.name]),
        );
        const r = await enqueueVaultWrite(ctx, ctx.pool, target.vaultId, {
          path: `${target.folder}/${TASTE_FILE}`,
          mode: 'section',
          section: { id: TASTE_SEED_SECTION_ID, version: ev.payload.version },
          content: renderTasteSeedSection(ev.payload.rules as TasteSeedLine[], names),
          header: TASTE_HEADER,
          commitMessage: `aom: taste rules v${ev.payload.version}`,
        });
        if (r.queued && r.workstationId) await ctx.services.gateway.deliverPending(r.workstationId);
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
          `aom: taste rule ${d.body}`.replace(/\s+/g, ' ').slice(0, 100),
        );
      }
    } catch (err) {
      ctx.log.warn({ err }, 'feed vault write hook failed');
    }
  });
}
