import type { Audience } from '../events/envelope.ts';
import { type OrgRole, type Rank, rankOf } from '../orgs/index.ts';

/**
 * Pure policy predicates (docs/ARCHITECTURE.md section 17), shared by the server (enforcement) and the web
 * app (hiding buttons). The server remains the only authority: it also joins the SQL visibility predicate.
 */

/** The user's membership in a project: `owner` and `manager` are active members; null = not a member. */
export type ProjectRole = 'owner' | 'manager' | null | undefined;

export const isProjectMember = (role: ProjectRole): boolean => role === 'owner' || role === 'manager';
export const isProjectOwner = (role: ProjectRole): boolean => role === 'owner';

// ---- projects (a project's `owner` is the organization's Owner and Admins: `project_members.org_grant`)
export const canUpdateProject = isProjectOwner;
export const canCreateCard = isProjectMember;
export const canCommentOnCard = isProjectMember;
export const canViewProject = isProjectMember;

// ---- cards
export interface CardAuthContext {
  userId: string;
  projectRole: ProjectRole;
  cardOwnerUserId: string;
}

/** Edit fields, specify, set priority/completion action/decision policy, cancel, re-home, manual move, release. */
export function canManageCard(c: CardAuthContext): boolean {
  return isProjectOwner(c.projectRole) || (isProjectMember(c.projectRole) && c.cardOwnerUserId === c.userId);
}

/** Answer a desk item for a card: `owner_only` -> card owner; `any_manager` -> any active member. */
export function canAnswerCardDeskItem(
  c: CardAuthContext & { policy: 'owner_only' | 'any_manager' },
): boolean {
  if (!isProjectMember(c.projectRole)) return false;
  return c.policy === 'any_manager' || c.cardOwnerUserId === c.userId;
}

// ---- workstations
/** Own workstations only (pair, rename, unlink, DevOps access): organization roles do not reach other people's machines. */
export const canManageWorkstation = (user: { id: string }, workstationUserId: string): boolean =>
  user.id === workstationUserId;
export const canUnlinkWorkstation = canManageWorkstation;

// =====================================================================================================================
// Organizations (docs/design/organizations.md section 4): what the server enforces and the web app uses to hide
// controls. Nothing compares a user id with an organization id any more (`authz-no-user-org.test.ts` greps for it).
// =====================================================================================================================

/** The acting user relative to ONE organization. */
export interface OrgActor {
  userId: string;
  kind: 'user' | 'super_admin';
  /** The user's active role in the organization, or null (not a member). */
  orgRole: OrgRole | null;
  /** Not a member, but active on at least one project of the organization. */
  isGuest: boolean;
}

export const isOrgManager = (a: Pick<OrgActor, 'orgRole'>): boolean =>
  a.orgRole === 'owner' || a.orgRole === 'admin';
export const isOrgOwner = (a: Pick<OrgActor, 'orgRole'>): boolean => a.orgRole === 'owner';
export const isOrgMember = (a: Pick<OrgActor, 'orgRole'>): boolean => a.orgRole !== null;

export const actorRank = (a: Pick<OrgActor, 'orgRole' | 'isGuest'>): Rank => rankOf(a.orgRole, a.isGuest);

/** Only the Owner and Admins create projects (owner decision 4) and add people (members and guests). */
export const canCreateProject = isOrgManager;
/** Converting a project (restructure.md section 8): the organization's Owner and Admins. */
export const canConvertProject = isOrgManager;
export const canAddPeople = isOrgManager;
export const canRenameOrg = isOrgManager;
export const canInviteOrgMember = (a: Pick<OrgActor, 'orgRole'>, role: 'admin' | 'member'): boolean =>
  role === 'member' ? isOrgManager(a) : isOrgOwner(a);
export const canChangeOrgRole = isOrgOwner;
export const canRemoveOrgMember = (a: Pick<OrgActor, 'orgRole'>, target: OrgRole): boolean =>
  target === 'owner' ? false : target === 'admin' ? isOrgOwner(a) : isOrgManager(a);
export const canTransferOwnership = isOrgOwner;
export const canViewOrgPlan = isOrgManager;
export const canSetOrgSecurity = isOrgOwner;

/**
 * Hire: O/A any agent with any allow-list; Members and Guests onto their own workstation, with an allow-list
 * (`projectScoped`: a non-empty project list) made only of projects they are on (`projectMember`).
 */
export function canHireAgentInOrg(c: {
  orgRole: OrgRole | null;
  projectScoped: boolean;
  projectMember: boolean;
}): boolean {
  if (c.orgRole === 'owner' || c.orgRole === 'admin') return true;
  return c.projectScoped && c.projectMember;
}
/** Change, fire, rehome, narrow permissions: any agent for O/A; Members and Guests their own hires. */
export const canManageAgentInOrg = (c: {
  userId: string;
  orgRole: OrgRole | null;
  managerUserId: string;
}): boolean => c.orgRole === 'owner' || c.orgRole === 'admin' || c.userId === c.managerUserId;
/** Widening an agent's permissions is for the Owner and Admins only. */
export const canWidenPermissions = isOrgManager;
/**
 * Direct / chat with an agent: O/A any; others only an agent that is allowed on a project they are on
 * (`sharesAllowedProject`).
 */
export const canDirectAgentInOrg = (c: { orgRole: OrgRole | null; sharesAllowedProject: boolean }): boolean =>
  c.orgRole === 'owner' || c.orgRole === 'admin' || c.sharesAllowedProject;
/** Custom roles, workflows, departments and standing orders of the organization. */
export const canDesignInOrg = isOrgManager;
/** Org-level vaults, org reporting settings, org-level desk items. */
export const canManageOrgAssets = isOrgManager;

/**
 * Interest edit rule (owner decision 13, section 4.3): the creator may always edit their own interest while they can
 * view it; otherwise the actor's rank must be at least the creator's current rank (stored rank as the fallback).
 */
export function canEditInterest(
  actor: { userId: string; rank: Rank },
  creator: { userId: string | null; rank: Rank },
  canView: boolean,
): boolean {
  if (!canView) return false;
  if (creator.userId !== null && actor.userId === creator.userId) return true;
  return actor.rank >= creator.rank;
}
/** The creator's rank for the rule: current when they still have a relationship with the org, else the stored one. */
export const effectiveCreatorRank = (current: Rank, stored: Rank | null | undefined): Rank =>
  current > 0 ? current : ((stored ?? 1) as Rank);

/**
 * Schedules (owner decision): project-bound actions for O/A and for people on the project (guests: shared project only,
 * which is the same test); org-level actions for O/A only; workstation-targeted ones additionally for the target's user.
 */
export function canEditSchedule(
  a: Pick<OrgActor, 'userId' | 'orgRole'>,
  s: { projectId: string | null; projectMember: boolean; targetWorkstationUserId?: string | null },
): boolean {
  if (a.orgRole === 'owner' || a.orgRole === 'admin') return true;
  if (s.targetWorkstationUserId && s.targetWorkstationUserId === a.userId) return true;
  return s.projectId !== null && s.projectMember;
}

export interface EventViewer {
  userId: string;
  kind: 'user' | 'super_admin';
  /** The viewer's role in the socket's organization (null: not a member). */
  orgRole: OrgRole | null;
  visibleProjectIds: ReadonlySet<string> | readonly string[];
}
export interface OrgEventVisibility {
  audience: Audience;
  orgId: string | null;
  projectId: string | null;
  userId?: string | null;
}

/**
 * Event visibility for browser replay and fan-out (section 6). `stripped` events carry only type, stream, seq and
 * actor (org-level events for Members). Super admins see the `admin` audience only; `system` is never visible.
 */
export function eventAccess(
  v: EventViewer,
  ev: OrgEventVisibility,
  socketOrgId: string | null,
): 'full' | 'stripped' | false {
  if (v.kind === 'super_admin') return ev.audience === 'admin' ? 'full' : false;
  const projects =
    v.visibleProjectIds instanceof Set
      ? v.visibleProjectIds
      : new Set(v.visibleProjectIds as readonly string[]);
  switch (ev.audience) {
    case 'org':
      if (socketOrgId === null || ev.orgId !== socketOrgId || v.orgRole === null) return false;
      return v.orgRole === 'member' ? 'stripped' : 'full';
    case 'project':
      return ev.projectId !== null && projects.has(ev.projectId) ? 'full' : false;
    case 'user':
      return ev.userId != null && ev.userId === v.userId ? 'full' : false;
    default:
      return false;
  }
}

/** Does the agent's allow-list (null: any project) let it work on the project? */
export const agentAllowsProject = (allowedProjectIds: readonly string[] | null, projectId: string): boolean =>
  allowedProjectIds === null || allowedProjectIds.includes(projectId);
