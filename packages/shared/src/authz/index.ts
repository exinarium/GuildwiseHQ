import type { Audience } from '../events/envelope.ts';

/**
 * Pure policy predicates (docs/ARCHITECTURE.md section 17), shared by the server (enforcement) and the web
 * app (hiding buttons). The server remains the only authority: it also joins the SQL visibility predicate.
 */

export interface AuthUser {
  id: string;
  role: 'admin' | 'member';
}

/** The user's membership in a project: `owner` and `manager` are active members; null = not a member. */
export type ProjectRole = 'owner' | 'manager' | null | undefined;

export const isAdmin = (u: Pick<AuthUser, 'role'>): boolean => u.role === 'admin';
export const isProjectMember = (role: ProjectRole): boolean => role === 'owner' || role === 'manager';
export const isProjectOwner = (role: ProjectRole): boolean => role === 'owner';

export interface EventVisibility {
  audience: Audience;
  orgId: string | null;
  projectId: string | null;
}

/**
 * Event visibility for browser replay and fan-out. Admins get the `admin` audience only; being admin grants
 * no visibility into other users' projects, cards, agents or desk. `system` events are never visible.
 */
export function canSeeEvent(
  user: AuthUser,
  ev: EventVisibility,
  visibleProjectIds: ReadonlySet<string> | readonly string[],
): boolean {
  const projects =
    visibleProjectIds instanceof Set ? visibleProjectIds : new Set(visibleProjectIds as readonly string[]);
  switch (ev.audience) {
    case 'org':
      return ev.orgId === user.id;
    case 'project':
      return ev.projectId !== null && projects.has(ev.projectId);
    case 'admin':
      return isAdmin(user);
    default:
      return false;
  }
}

// ---- projects
export const canUpdateProject = isProjectOwner;
export const canShareProject = isProjectOwner;
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
export const canManageWorkstation = (user: AuthUser, workstationUserId: string): boolean =>
  user.id === workstationUserId;
export const canUnlinkWorkstation = (user: AuthUser, workstationUserId: string): boolean =>
  user.id === workstationUserId || isAdmin(user);

// ---- agents
export interface AgentAuthContext {
  userId: string;
  orgId: string;
  managerUserId: string;
  /** Agent's project scope (null = org-wide). */
  agentProjectId: string | null;
  /** The user's role in the agent's project, when scoped. */
  projectRole?: ProjectRole;
}

/** Hire org-wide: the org owner. Hire for a shared project: any active member (project_id set). */
export function canHireAgent(c: {
  userId: string;
  orgId: string;
  projectRole?: ProjectRole;
  projectScoped: boolean;
}): boolean {
  if (!c.projectScoped) return c.userId === c.orgId;
  return c.userId === c.orgId || isProjectMember(c.projectRole);
}

/** Change / fire / rehome: the org owner (any agent of the org) or the agent's current HR manager. */
export const canManageAgent = (c: Pick<AgentAuthContext, 'userId' | 'orgId' | 'managerUserId'>): boolean =>
  c.userId === c.orgId || c.userId === c.managerUserId;

/** Direct / chat: org owner for org-wide agents; any active member for project-scoped agents. */
export function canDirectAgent(c: AgentAuthContext): boolean {
  if (c.userId === c.orgId) return true;
  return c.agentProjectId !== null && isProjectMember(c.projectRole);
}

// ---- org designer
export const canDesignOrg = (userId: string, orgId: string): boolean => userId === orgId;
