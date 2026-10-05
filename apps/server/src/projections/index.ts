import type { Projector, ProjectorMap } from '../eventstore/types.ts';
import { agentProjectors } from './agents.ts';
import { cardProjectors } from './cards.ts';
import { catalogueProjectors } from './catalogue.ts';
import { chatProjectors } from './chats.ts';
import { deskProjectors } from './desk.ts';
import { devopsProjectors } from './devops.ts';
import { feedProjectors } from './feeds.ts';
import { hygieneProjectors } from './hygiene.ts';
import { intakeProjectors } from './intake.ts';
import { ledgerProjectors } from './ledger.ts';
import { outboundProjectors } from './outbound.ts';
import { phaseProjectors } from './phases.ts';
import { projectProjectors } from './projects.ts';
import { repoProjectors } from './repo.ts';
import { reporterProjectors } from './reporter.ts';
import { researchProjectors } from './research.ts';
import { scheduleProjectors } from './schedules.ts';
import { sharingProjectors } from './sharing.ts';
import { shiftProjectors } from './shifts.ts';
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
  catalogueProjectors,
  workstationProjectors,
  projectProjectors,
  agentProjectors,
  cardProjectors,
  shiftProjectors,
  threadProjectors,
  deskProjectors,
  ledgerProjectors,
  chatProjectors,
  vaultProjectors,
  devopsProjectors,
  hygieneProjectors,
  sharingProjectors,
  testingProjectors,
  scheduleProjectors,
  feedProjectors,
  researchProjectors,
  intakeProjectors,
  trackRecordProjectors,
  outboundProjectors,
  repoProjectors,
  phaseProjectors,
  reporterProjectors,
];

export function buildProjectors(): ProjectorMap {
  const map: ProjectorMap = {};
  for (const d of domains) {
    for (const [type, fn] of Object.entries(d)) {
      const list = map[type] ?? [];
      list.push(fn);
      map[type] = list;
    }
  }
  return map;
}

/**
 * Every table written by a projector; `projections:rebuild` truncates these (CASCADE) and replays all events.
 * Operational tables that reference them are saved and restored by the rebuild (see scripts/projections-rebuild.ts).
 */
export const PROJECTION_TABLES = [
  'users',
  'invitations',
  'workstations',
  'projects',
  'project_repos',
  'project_members',
  'workflow_versions',
  'workflow_stages',
  'role_definitions',
  'role_extensions',
  'departments',
  'agents',
  'cards',
  'card_dependencies',
  'card_handoffs',
  'card_transitions',
  'card_activity',
  'shifts',
  'threads',
  'thread_messages',
  'desk_items',
  'card_blockers',
  'ledger_entries',
  'vaults',
  'devops_requests',
  'environment_changes',
  'test_runs',
  'schedules',
  'digest_items',
  'feed_seen',
  'research_publications',
  'intakes',
  'intake_cards',
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
];
