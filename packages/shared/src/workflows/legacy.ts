import type { WorkflowDefinition } from './schema.ts';

/**
 * The one legacy alias of the workflow catalogue. For a few days in October 2026 the lean team flow was registered as a
 * workflow of its own with the key `code-v6`; the owner folded it into the built-in `code` (version 6). The key is NOT a
 * workflow anyone can see or select any more: it exists only so that
 *   - events written before the fold replay (they name the key in `ProjectWorkflowsSet`, `ProjectCreated`, the
 *     `WorkflowVersionRegistered` of its row ...), and
 *   - a database that has not run the fold step yet (data-migrations/lean-rollout.ts, step 5) keeps working: the resolver
 *     maps the key to `code`, and the stored definition of the old row still counts as a lean team workflow.
 * Nothing outside this module, the resolver, the projections and the fold step may name the key.
 */
export const LEGACY_CODE_V6_KEY = 'code-v6';

/** The key a workflow key resolves to (the legacy alias to `code`; every other key as it is). */
export const canonicalWorkflowKey = (key: string): string => (key === LEGACY_CODE_V6_KEY ? 'code' : key);

/**
 * Is this the lean team flow (planning, design for every card, pre-review, owner approval, test deploy, area E2E, manual
 * full suite, groups)? The definition says so (`leanTeam`, set on built-in `code` from version 6); the stored definition
 * of the legacy `code-v6` row predates the flag and counts too. Features come from this, never from a key.
 */
export const isLeanTeamWorkflow = (def: Pick<WorkflowDefinition, 'key' | 'leanTeam'>): boolean =>
  def.leanTeam === true || def.key === LEGACY_CODE_V6_KEY;
