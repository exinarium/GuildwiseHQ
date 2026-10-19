import type { Projector, ProjectorMap } from '../eventstore/types.ts';
import { agentProjectors } from './agents.ts';
import { blogProjectors } from './blog.ts';
import { cardProjectors, releaseHeldDesigns } from './cards.ts';
import { catalogueProjectors } from './catalogue.ts';
import { ceoProjectors } from './ceo.ts';
import { chatProjectors } from './chats.ts';
import { codeV6Projectors } from './code-v6.ts';
import { commitAsProjectors } from './commit-as.ts';
import { costProjectors } from './costs.ts';
import { deskProjectors } from './desk.ts';
import { devopsProjectors } from './devops.ts';
import { environmentProjectors } from './environment.ts';
import { feedProjectors } from './feeds.ts';
import { graphProjectors } from './graph.ts';
import { hygieneProjectors } from './hygiene.ts';
import { intakeProjectors } from './intake.ts';
import { intakeBatchProjectors } from './intake-batch.ts';
import { interestRunProjectors } from './interest-runs.ts';
import { interestProjectors } from './interests.ts';
import { ledgerProjectors } from './ledger.ts';
import { orgProjectors } from './orgs.ts';
import { outboundProjectors } from './outbound.ts';
import { phaseProjectors } from './phases.ts';
import { platformProjectors } from './platform.ts';
import { platformAuditProjectors } from './platform-audit.ts';
import { projectWorkflowProjectors } from './project-workflows.ts';
import { projectProjectors } from './projects.ts';
import { questionFlowProjectors } from './question-flow.ts';
import { repoProjectors } from './repo.ts';
import { reporterProjectors } from './reporter.ts';
import { researchProjectors } from './research.ts';
import { runProjectors } from './runs.ts';
import { scheduleProjectors } from './schedules.ts';
import { sharingProjectors } from './sharing.ts';
import { shiftProjectors } from './shifts.ts';
import { subworkflowProjectors } from './subworkflows.ts';
import { testingProjectors } from './testing.ts';
import { threadProjectors } from './threads.ts';
import { trackRecordProjectors } from './track-record.ts';
import { userProjectors } from './users.ts';
import { vaultProjectors } from './vaults.ts';
import { workstationProjectors } from './workstations.ts';

/**
 * Registry: later domains add one import and one `...register(...)` line below (docs/PLAN.md rule 3).
 * Projectors are deterministic functions of the event and prior projection state (use `e.createdAt`, never now()).
 */
const domains: Array<Record<string, Projector>> = [
  userProjectors,
  orgProjectors,
  platformAuditProjectors,
  platformProjectors,
  blogProjectors,
  catalogueProjectors,
  workstationProjectors,
  projectProjectors,
  projectWorkflowProjectors,
  agentProjectors,
  cardProjectors,
  subworkflowProjectors,
  shiftProjectors,
  costProjectors,
  threadProjectors,
  deskProjectors,
  ledgerProjectors,
  chatProjectors,
  vaultProjectors,
  graphProjectors,
  devopsProjectors,
  environmentProjectors,
  hygieneProjectors,
  sharingProjectors,
  testingProjectors,
  scheduleProjectors,
  feedProjectors,
  researchProjectors,
  intakeProjectors,
  intakeBatchProjectors,
  trackRecordProjectors,
  outboundProjectors,
  repoProjectors,
  phaseProjectors,
  reporterProjectors,
  interestProjectors,
  interestRunProjectors,
  runProjectors,
  commitAsProjectors,
  ceoProjectors,
  questionFlowProjectors,
  codeV6Projectors,
];

/**
 * Events after which a held design may be released: every card event (a dependency done, cancelled, its dependencies
 * edited, the claim released) and the two merge events of the phase projector. The release runs last for its event.
 */
const RELEASES_HELD_DESIGNS = new Set([
  ...Object.keys(cardProjectors),
  ...Object.keys(subworkflowProjectors),
  'CardFinalized',
  'CardMergeVerified',
  'ClaimReleased',
]);

export function buildProjectors(): ProjectorMap {
  const map: ProjectorMap = {};
  for (const d of domains) {
    for (const [type, fn] of Object.entries(d)) {
      const list = map[type] ?? [];
      list.push(fn);
      map[type] = list;
    }
  }
  for (const type of RELEASES_HELD_DESIGNS) {
    const list = map[type] ?? [];
    list.push((tx, e) => releaseHeldDesigns(tx, e));
    map[type] = list;
  }
  return map;
}

/**
 * Every table written by a projector; `projections:rebuild` truncates these (CASCADE) and replays all events.
 * Operational tables that reference them are saved and restored by the rebuild (see scripts/projections-rebuild.ts).
 */
export const PROJECTION_TABLES = [
  'users',
  'organizations',
  'org_members',
  'platform_audit_log',
  'platform_pauses',
  'invitations',
  'blog_posts',
  'workstations',
  'projects',
  'project_repos',
  'project_members',
  'project_workflows',
  'workflow_versions',
  'workflow_stages',
  'role_definitions',
  'role_extensions',
  'departments',
  'agents',
  'ceo_settings',
  'ceo_actions',
  'ceo_tasks',
  'ceo_memories',
  'cards',
  'card_dependencies',
  'card_groups',
  'subworkflow_runs',
  'card_handoffs',
  'card_transitions',
  'card_activity',
  'card_attachments',
  'shifts',
  'shift_costs',
  'threads',
  'chat_archives',
  'thread_messages',
  'desk_items',
  'card_blockers',
  'ledger_entries',
  'ledger_entry_versions',
  'vaults',
  'project_graphs',
  'shift_context_metrics',
  'org_graph_links',
  'devops_requests',
  'run_plans',
  'repo_clones',
  'project_environments',
  'environment_changes',
  'test_runs',
  'test_suite_results',
  'schedules',
  'schedule_runs',
  'schedule_attempts',
  'schedule_issues',
  'digest_items',
  'feed_seen',
  'research_publications',
  'interest_runs',
  'interest_deliveries',
  'intakes',
  'intake_cards',
  'intake_batches',
  'intake_batch_items',
  'agent_card_stats',
  'agent_review_log',
  'agent_stats_daily',
  'hr_applied',
  'outbound_drafts',
  'repo_requests',
  'deploy_targets',
  'phases',
  'phase_followups',
  'ba_tasks',
  'ba_signals',
  'hygiene_findings',
  'interests',
  'taste_seeds',
];
