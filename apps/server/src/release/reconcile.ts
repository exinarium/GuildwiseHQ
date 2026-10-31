import { randomUUID } from 'node:crypto';
import { type ReleaseFacts, streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { buildProposal } from './proposal.ts';
import { loadComponentRules } from './rules.ts';

type Trigger = 'release_pr' | 'ahead' | 'manual';

/**
 * Keeps one live "Ship release" proposal per repository in step with the facts, in one transaction (the global append
 * lock serialises two results, and the partial unique index `release_proposals_one_live` is the final guard).
 * 1. An approved proposal whose version is at or below the newest tag is released: closed.
 * 2. An open proposal with nothing ahead of main is closed and its desk item dismissed.
 * 3. No live proposal, something ahead and not suppressed: a desk item and `ReleaseProposed`.
 * 4. An open proposal while the facts moved: nothing is appended; the desk item reads the facts live.
 */
export async function reconcileReleaseProposal(ctx: Ctx, repoId: string, trigger: Trigger): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const repo = await one(
      tx,
      `SELECT r.id, r.name, r.project_id, p.org_id FROM project_repos r JOIN projects p ON p.id = r.project_id
        WHERE r.id=$1 AND r.removed_at IS NULL FOR UPDATE OF r`,
      [repoId],
    );
    if (!repo) return;
    const f = await one(tx, `SELECT facts FROM repo_release_facts WHERE project_repo_id=$1 AND state='ready'`, [
      repoId,
    ]);
    if (!f?.facts) return;
    const facts = f.facts as ReleaseFacts;
    const scope = projectScope(repo.org_id, repo.project_id);
    const live = await one(
      tx,
      `SELECT * FROM release_proposals WHERE repo_id=$1 AND state IN ('proposed','approved')`,
      [repoId],
    );
    if (live?.state === 'approved') {
      const tags = facts.existingTags ?? [];
      const tag = live.version && tags.includes(`v${live.version}`) ? `v${live.version}` : null;
      if (tag)
        await ctx.store.append(
          [
            {
              streamId: streamId.release(live.id),
              event: {
                type: 'ReleaseProposalClosed',
                payload: { proposalId: live.id, repoId, reason: 'released', tag },
              },
              actor: SYSTEM_ACTOR,
              scope,
            },
          ],
          { tx },
        );
      return;
    }
    if (live) {
      if (facts.ahead === 0)
        await ctx.store.append(
          [
            {
              streamId: streamId.release(live.id),
              event: {
                type: 'ReleaseProposalClosed',
                payload: { proposalId: live.id, repoId, reason: 'nothing_to_release' },
              },
              actor: SYSTEM_ACTOR,
              scope,
            },
            {
              streamId: streamId.desk(live.desk_item_id),
              event: {
                type: 'DeskItemResolved',
                payload: {
                  deskItemId: live.desk_item_id,
                  resolution: 'dismissed',
                  note: 'The working branch has nothing the main branch lacks any more.',
                  by: { kind: 'system' },
                },
              },
              actor: SYSTEM_ACTOR,
              scope,
            },
          ],
          { tx },
        );
      return;
    }
    if (facts.ahead === 0) return;
    if (trigger === 'ahead') {
      const last = await one(
        tx,
        `SELECT closed_reason, last_tag FROM release_proposals WHERE repo_id=$1 AND state IN ('dismissed','released','closed')
          ORDER BY updated_at DESC LIMIT 1`,
        [repoId],
      );
      const lastTag = facts.lastTag?.name ?? null;
      if (last && last.closed_reason !== 'nothing_to_release' && (last.last_tag ?? null) === lastTag) return;
    }
    const built = buildProposal(facts, await loadComponentRules(tx, repoId));
    const proposalId = randomUUID();
    const deskItemId = randomUUID();
    await ctx.store.append(
      [
        {
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'approval',
              subkind: 'ship_release',
              title: `Ship release: ${repo.name}`,
              body: `${built.recommended.reason}. Approving prepares the release commit (changelog and component versions) and pushes it to the working branch. Nothing is tagged or published yet.`,
              options: [],
              blocking: false,
              pinned: false,
              projectId: repo.project_id,
              affectedCardIds: [],
              askedBy: { kind: 'system' },
              data: { repoId, proposalId },
              subjectKey: `ship_release:${repoId}`,
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        {
          streamId: streamId.release(proposalId),
          event: {
            type: 'ReleaseProposed',
            payload: {
              proposalId,
              projectId: repo.project_id,
              repoId,
              deskItemId,
              trigger,
              recommendedVersion: built.recommended.version,
              level: built.recommended.level,
              reason: built.recommended.reason,
              lastTag: facts.lastTag?.name ?? null,
              headSha: facts.headSha,
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
      ],
      { tx },
    );
  });
}
