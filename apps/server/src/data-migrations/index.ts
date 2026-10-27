import { migrateBlogCiteCleanup } from './blog-cite-cleanup.ts';
import { migrateBlogLaunch } from './blog-launch.ts';
import { migrateCardCompletionInherit } from './card-completion-inherit.ts';
import { migrateCeoAuthority, migrateCeoDecisionDedupe } from './ceo-authority.ts';
import { migrateCeoBuiltin } from './ceo-builtin.ts';
import { migrateCeoModels } from './ceo-models.ts';
import { migrateCeoWorkingBranch } from './ceo-working-branch.ts';
import { migrateDelegationExplicit } from './delegation-explicit.ts';
import { migrateDesignHeldStatus } from './design-held-status.ts';
import { migrateGraphBackfill } from './graph-backfill.ts';
import { migrateGuidedMode } from './guided-mode.ts';
import { migrateNoPersonal } from './no-personal.ts';
import { migrateOrgInboxes } from './org-inboxes.ts';
import { type DataMigrationEnv, migrateOrgs } from './orgs.ts';
import { migratePackSkillKeys } from './pack-skill-keys.ts';
import { migrateProjectVaults } from './project-vaults.ts';
import { migratePushBranchRetired } from './push-branch-retired.ts';
import { migrateReporterRetired } from './reporter-retired.ts';
import { migrateRestructure } from './restructure.ts';
import { migrateStrandedTestCards } from './stranded-test-cards.ts';
import { migrateSuspiciousRoles } from './suspicious-roles.ts';

export {
  BLOG_CITE_CLEANUP_MIGRATION,
  type BlogCiteCleanupReport,
  migrateBlogCiteCleanup,
} from './blog-cite-cleanup.ts';
export { BLOG_LAUNCH_MIGRATION, loadLaunchArticles, migrateBlogLaunch } from './blog-launch.ts';
export {
  CARD_COMPLETION_INHERIT_MIGRATION,
  type CardCompletionInheritReport,
  migrateCardCompletionInherit,
} from './card-completion-inherit.ts';
export {
  CEO_AUTHORITY_MIGRATION,
  CEO_DECISION_DEDUPE_MIGRATION,
  migrateCeoAuthority,
  migrateCeoDecisionDedupe,
} from './ceo-authority.ts';
export { CEO_BUILTIN_MIGRATION, type CeoBuiltinReport, migrateCeoBuiltin } from './ceo-builtin.ts';
export { CEO_MODELS_MIGRATION, type CeoModelsReport, migrateCeoModels } from './ceo-models.ts';
export { CEO_WORKING_BRANCH_MIGRATION, migrateCeoWorkingBranch } from './ceo-working-branch.ts';
export {
  DESIGN_HELD_STATUS_MIGRATION,
  type DesignHeldStatusReport,
  migrateDesignHeldStatus,
} from './design-held-status.ts';
export {
  GRAPH_BACKFILL_MIGRATION,
  type GraphBackfillReport,
  migrateGraphBackfill,
} from './graph-backfill.ts';
export {
  formatNoPersonalPlan,
  migrateNoPersonal,
  NO_PERSONAL_MIGRATION,
  planNoPersonal,
} from './no-personal.ts';
export { migrateOrgInboxes, ORG_INBOXES_MIGRATION } from './org-inboxes.ts';
export { type DataMigrationEnv, formatPlan, migrateOrgs, ORGS_MIGRATION, planOrgMigration } from './orgs.ts';
export {
  migratePackSkillKeys,
  PACK_SKILL_KEYS_MIGRATION,
  type PackSkillKeysReport,
} from './pack-skill-keys.ts';
export {
  migrateProjectVaults,
  PROJECT_VAULTS_MIGRATION,
  type ProjectVaultsReport,
} from './project-vaults.ts';
export {
  migratePushBranchRetired,
  PUSH_BRANCH_RETIRED_MIGRATION,
  type PushBranchRetiredReport,
} from './push-branch-retired.ts';
export {
  migrateReporterRetired,
  REPORTER_RETIRED_MIGRATION,
  type ReporterRetiredReport,
} from './reporter-retired.ts';
export {
  formatRestructurePlan,
  migrateRestructure,
  planRestructure,
  RESTRUCTURE_MIGRATION,
} from './restructure.ts';
export {
  migrateStrandedTestCards,
  STRANDED_TEST_CARDS_MIGRATION,
  type StrandedTestCardsReport,
} from './stranded-test-cards.ts';

/**
 * Boot data migrations, run after the SQL migrations and before the dispatcher, scheduler and HTTP listener
 * (docs/design/organizations.md section 2.3). Each is idempotent. `restructure-2026-10` follows `orgs-2026-10`, `no-personal-2026-10` follows `restructure-2026-10`.
 */
export const DATA_MIGRATIONS: Array<{ name: string; run: (env: DataMigrationEnv) => Promise<unknown> }> = [
  { name: 'orgs-2026-10', run: (env) => migrateOrgs(env) },
  { name: 'restructure-2026-10', run: (env) => migrateRestructure(env) },
  { name: 'no-personal-2026-10', run: (env) => migrateNoPersonal(env) },
  { name: 'blog-launch-2026-10', run: (env) => migrateBlogLaunch(env) },
  { name: 'blog-cite-cleanup-2026-10', run: (env) => migrateBlogCiteCleanup(env) },
  { name: 'card-completion-inherit-2026-10', run: (env) => migrateCardCompletionInherit(env) },
  { name: 'push-branch-retired-2026-10', run: (env) => migratePushBranchRetired(env) },
  { name: 'org-inboxes-2026-10', run: (env) => migrateOrgInboxes(env) },
  { name: 'ceo-models-2026-10', run: (env) => migrateCeoModels(env) },
  { name: 'design-held-status-2026-10', run: (env) => migrateDesignHeldStatus(env) },
  { name: 'ceo-working-branch-2026-10', run: (env) => migrateCeoWorkingBranch(env) },
  { name: 'ceo-builtin-2026-10', run: (env) => migrateCeoBuiltin(env) },
  { name: 'project-vaults-2026-10', run: (env) => migrateProjectVaults(env) },
  { name: 'graph-backfill-2026-10', run: (env) => migrateGraphBackfill(env) },
  { name: 'reporter-retired-2026-10', run: (env) => migrateReporterRetired(env) },
  { name: 'guided-mode-2026-10', run: (env) => migrateGuidedMode(env) },
  { name: 'ceo-authority-2026-10', run: (env) => migrateCeoAuthority(env) },
  { name: 'ceo-decision-dedupe-2026-10', run: (env) => migrateCeoDecisionDedupe(env) },
  { name: 'stranded-test-cards-2026-10', run: (env) => migrateStrandedTestCards(env) },
  { name: 'delegation-explicit-2026-10', run: (env) => migrateDelegationExplicit(env) },
  { name: 'suspicious-roles-2026-10', run: (env) => migrateSuspiciousRoles(env) },
  { name: 'pack-skill-keys-2026-10', run: (env) => migratePackSkillKeys(env) },
];

export async function runDataMigrations(env: DataMigrationEnv): Promise<void> {
  for (const m of DATA_MIGRATIONS) {
    env.log(`data migration ${m.name}`);
    await m.run(env);
  }
}
