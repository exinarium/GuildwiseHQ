import { isOrgOperational } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { conflict } from '../errors.ts';
import type { Interceptor } from '../eventstore/pg-event-store.ts';

/**
 * Event types a user may still cause in an organization that is not running (suspended or cancelled): the Owner
 * works on the organization itself (settings, members, invitations), takes members off projects and hands their work
 * back, and keeps their own account. Everything else (cards, projects, agents, desk answers, ...) is refused.
 */
const ALLOWED_WHEN_SUSPENDED = [
  /^Org/,
  /^Invitation/,
  /^MemberPasswordReset$/,
  /^TwoFactor/,
  /^PlatformOrg/,
  /^(ProjectMemberRemoved|ClaimReleased|CardRehomed|AgentRetired|PasswordChanged|UserAvatarSet|UserTimezoneChanged|UserTourStateChanged|UserWhatsNewSeen|UserSetupChecklistChanged)$/,
];
const ALLOWED_WHEN_CANCELLED = [
  /^TwoFactor/,
  /^(PasswordChanged|UserAvatarSet|UserTimezoneChanged|UserTourStateChanged|UserWhatsNewSeen|UserSetupChecklistChanged)$/,
];

/**
 * The append-level backstop for "suspended means read-only" (docs/design/organizations.md section 7.2): an event
 * caused by a user in an organization that is suspended or cancelled is refused with 409 `org_suspended`, whichever
 * route it came through. Agents, runners and the system are not blocked here: running shifts finish (the dispatcher
 * stops new claims), and licensing actions must be able to write. A super admin acts on the organization freely.
 */
export function createOrgStatusInterceptor(_ctx: Ctx): Interceptor {
  return async (tx, inputs) => {
    const orgIds = [
      ...new Set(
        inputs
          .filter((i) => i.actor.kind === 'user' && i.actor.id && i.scope.orgId)
          .map((i) => i.scope.orgId as string),
      ),
    ];
    if (orgIds.length === 0) return inputs;
    const orgs = await rows<{ id: string; status: string; name: string }>(
      tx,
      'SELECT id, status, name FROM organizations WHERE id = ANY($1::uuid[])',
      [orgIds],
    );
    const blocked = new Map(orgs.filter((o) => !isOrgOperational(o.status)).map((o) => [o.id, o]));
    if (blocked.size === 0) return inputs;
    const actors = [
      ...new Set(
        inputs.filter((i) => i.actor.kind === 'user' && i.actor.id).map((i) => i.actor.id as string),
      ),
    ];
    const supers = new Set(
      (
        await rows<{ id: string }>(
          tx,
          `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND kind = 'super_admin'`,
          [actors],
        )
      ).map((u) => u.id),
    );
    for (const i of inputs) {
      if (i.actor.kind !== 'user' || !i.actor.id || !i.scope.orgId) continue;
      const org = blocked.get(i.scope.orgId);
      if (!org || supers.has(i.actor.id)) continue;
      const allowed = org.status === 'cancelled' ? ALLOWED_WHEN_CANCELLED : ALLOWED_WHEN_SUSPENDED;
      if (allowed.some((re) => re.test(i.event.type))) continue;
      throw conflict(
        'org_suspended',
        `${org.name} is ${org.status}: nothing can be changed until it is reactivated.`,
      );
    }
    return inputs;
  };
}
