import {
  type DeskResolution,
  type ReleaseFacts,
  type ReleaseProposalView,
  type ShipReleaseApproval,
  streamId,
  validateReleaseVersion,
} from '@aom/shared';
import { projectRole } from '../authz/scope.ts';
import { projectScope, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { badRequest, conflict, forbidden } from '../errors.ts';
import { loadFacts } from './facts.ts';
import { buildProposal } from './proposal.ts';
import { loadComponentRules } from './rules.ts';

/**
 * Resolves a "Ship release" desk item inside the caller's transaction. Only the project owner decides. Approving
 * validates the version against the facts the owner looked at, recomputes the component bumps (a client value is never
 * trusted), and appends `ReleaseApproved`. Nothing is queued: this step records the decision only.
 */
export async function resolveShipReleaseIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  item: Row,
  resolution: DeskResolution,
  release: ShipReleaseApproval | undefined,
): Promise<void> {
  if (item.project_id && (await projectRole(tx, user.id, item.project_id)) !== 'owner')
    throw forbidden('only the project owner can decide on a release');
  if (resolution === 'acknowledged')
    throw badRequest('wrong_resolution', 'a release is approved or rejected');
  const proposal = await one(
    tx,
    `SELECT * FROM release_proposals WHERE desk_item_id=$1 AND state='proposed' FOR UPDATE`,
    [item.id],
  );
  if (!proposal) {
    // The proposal was closed already (nothing to release, released): the item may still be dismissed.
    if (resolution === 'approved') throw conflict('proposal_closed', 'this release proposal is no longer open');
    return;
  }
  const scope = projectScope(item.org_id, proposal.project_id);
  if (resolution !== 'approved') {
    await ctx.store.append(
      [
        {
          streamId: streamId.release(proposal.id),
          event: {
            type: 'ReleaseProposalClosed',
            payload: {
              proposalId: proposal.id,
              repoId: proposal.repo_id,
              reason: resolution === 'rejected' ? 'rejected' : 'dismissed',
            },
          },
          actor: userActor(user.id),
          scope,
        },
      ],
      { tx },
    );
    return;
  }
  if (!release) throw badRequest('release_required', 'approving a release needs the version and the components');
  const stored = await loadFacts(tx, proposal.repo_id);
  if (!stored?.facts || stored.state === 'failed')
    throw conflict('facts_missing', 'The repository has not been read yet. Refresh the proposal and try again.');
  const facts: ReleaseFacts = stored.facts;
  if (release.factsHeadSha !== facts.headSha)
    throw conflict(
      'proposal_changed',
      'The working branch moved since you opened this item. Check the refreshed proposal and approve again.',
    );
  const check = validateReleaseVersion(release.version, facts.lastTag?.name ?? null, facts.existingTags);
  if (!check.ok) throw badRequest('invalid_version', check.message);
  const rules = await loadComponentRules(tx, proposal.repo_id);
  const levels: Record<string, 'patch' | 'minor' | 'major'> = {};
  for (const c of release.components) {
    if (!rules.some((r) => r.name === c.name)) throw badRequest('unknown_component', `unknown component "${c.name}"`);
    levels[c.name] = c.level;
  }
  const built = buildProposal(facts, rules, levels);
  const notes =
    built.notesSource === 'commits' ? (release.notes?.trim() || built.notes) : built.notes;
  await ctx.store.append(
    [
      {
        streamId: streamId.release(proposal.id),
        event: {
          type: 'ReleaseApproved',
          payload: {
            proposalId: proposal.id,
            projectId: proposal.project_id,
            repoId: proposal.repo_id,
            deskItemId: item.id,
            version: check.version,
            lastTag: facts.lastTag?.name ?? null,
            headSha: facts.headSha,
            components: built.components.map(({ under: _u, versionFile: _v, message: _m, ...c }) => c),
            notes,
            notesSource: built.notesSource,
            approvedBy: user.id,
          },
        },
        actor: userActor(user.id),
        scope,
      },
    ],
    { tx },
  );
}

const allAt = (rules: { name: string }[], level: 'minor' | 'major'): Record<string, 'minor' | 'major'> =>
  Object.fromEntries(rules.map((r) => [r.name, level]));

/** The live view of a Ship release desk item (facts and rules read now, so a refresh shows at once). */
export async function releaseViewFor(db: Queryable, item: Row): Promise<ReleaseProposalView | null> {
  const repoId = (item.data as { repoId?: string } | null)?.repoId;
  if (!repoId) return null;
  const proposal = await one(db, 'SELECT * FROM release_proposals WHERE desk_item_id=$1', [item.id]);
  const repo = await one(db, 'SELECT name FROM project_repos WHERE id=$1', [repoId]);
  if (!proposal || !repo) return null;
  const stored = await loadFacts(db, repoId);
  const rules = await loadComponentRules(db, repoId);
  const facts = stored?.facts ?? null;
  const today = new Date().toISOString().slice(0, 10);
  if (!facts)
    return {
      proposalId: proposal.id,
      projectId: proposal.project_id,
      repoId,
      repoName: repo.name,
      state: proposal.state,
      lastTag: proposal.last_tag ?? null,
      base: proposal.last_tag ? String(proposal.last_tag).replace(/^v/, '') : '0.0.0',
      recommended: {
        version: proposal.recommended_version,
        level: proposal.recommended_level,
        reason: proposal.reason,
      },
      headSha: proposal.head_sha,
      factsAt: stored?.at?.toISOString() ?? null,
      factsState: stored?.state ?? 'pending',
      factsMessage: stored?.message ?? null,
      ahead: 0,
      commitsTruncated: false,
      today,
      changelog: null,
      notes: '',
      notesEditable: true,
      components: [],
      componentVariants: { patch: [], minor: [], major: [] },
      rules: rules.map((r) => ({ name: r.name, paths: r.paths, versionFile: r.versionFile })),
      existingTags: [],
    };
  const built = buildProposal(facts, rules);
  return {
    proposalId: proposal.id,
    projectId: proposal.project_id,
    repoId,
    repoName: repo.name,
    state: proposal.state,
    lastTag: facts.lastTag?.name ?? null,
    base: built.base,
    recommended: built.recommended,
    headSha: facts.headSha,
    factsAt: stored?.at?.toISOString() ?? null,
    factsState: stored?.state ?? 'ready',
    factsMessage: stored?.message ?? null,
    ahead: facts.ahead,
    commitsTruncated: facts.commitsTruncated,
    today,
    changelog: built.changelog,
    notes: built.notes,
    notesEditable: built.notesEditable,
    components: built.components,
    componentVariants: {
      patch: built.components,
      minor: buildProposal(facts, rules, allAt(rules, 'minor')).components,
      major: buildProposal(facts, rules, allAt(rules, 'major')).components,
    },
    rules: rules.map((r) => ({ name: r.name, paths: r.paths, versionFile: r.versionFile })),
    existingTags: facts.existingTags,
  };
}
