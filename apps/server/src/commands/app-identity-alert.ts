import { randomUUID } from 'node:crypto';
import { APP_IDENTITY_FAILED_CODE, DESK_SUBKIND, streamId } from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { projectScope, SYSTEM_ACTOR } from './common.ts';

/**
 * The app-identity failure text of a runner answer (a shift rejection, a command result or a hygiene problem): the
 * `app_identity_failed:` wire text, or the plain "The app X could not be used: ..." sentence. Null for anything else.
 */
export function appIdentityFailureText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t.startsWith(`${APP_IDENTITY_FAILED_CODE}:`)) return t.slice(`${APP_IDENTITY_FAILED_CODE}:`.length).trim();
  if (/^The app .+? could not be used:/.test(t)) return t;
  return null;
}

/**
 * One open alert per project and title when work on a project stopped because its selected app could not be used:
 * shifts, repository commands (commit status, PR notice, refused commands) and DevOps hygiene. `what` names the work
 * ("Shifts", "Repository commands", "DevOps hygiene"); `detail` is the runner's text (it names the app, the project and
 * the operation, never a token).
 */
export async function appIdentityAlertEvents(
  db: Queryable,
  o: { orgId: string; projectId: string; cardId?: string | null; detail: string; what: string },
): Promise<AppendInput[]> {
  const project = await one<{ name: string }>(db, 'SELECT name FROM projects WHERE id=$1', [o.projectId]);
  if (!project) return [];
  const reason = (appIdentityFailureText(o.detail) ?? o.detail.trim()).slice(0, 1000);
  const label = /^The app (.+?) could not be used:/.exec(reason)?.[1] ?? 'selected';
  const title = `${o.what} for ${project.name} stopped: the app ${label} cannot be used`;
  const open = await one(
    db,
    `SELECT id FROM desk_items WHERE project_id=$1 AND subkind=$2 AND status='open' AND title=$3`,
    [o.projectId, DESK_SUBKIND.appIdentityFailed, title],
  );
  if (open) return [];
  const deskItemId = randomUUID();
  return [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: DESK_SUBKIND.appIdentityFailed,
          title,
          body: reason,
          options: [],
          blocking: false,
          pinned: false,
          ...(o.cardId ? { cardId: o.cardId } : {}),
          projectId: o.projectId,
          affectedCardIds: [],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(o.orgId, o.projectId),
    },
  ];
}

/**
 * The project a runner command acts on, from its payload: `projectId`, else the repository's project (`repoId`), else
 * the card's project (`cardId`). Null when the command names none of them.
 */
export async function commandProject(
  db: Queryable,
  payload: unknown,
): Promise<{ projectId: string; orgId: string; cardId: string | null } | null> {
  const p = (payload ?? {}) as { projectId?: unknown; repoId?: unknown; cardId?: unknown };
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  const cardId = str(p.cardId);
  const byProject = str(p.projectId);
  const row = byProject
    ? await one<{ id: string; org_id: string }>(db, 'SELECT id, org_id FROM projects WHERE id=$1', [byProject])
    : str(p.repoId)
      ? await one<{ id: string; org_id: string }>(
          db,
          'SELECT p.id, p.org_id FROM project_repos r JOIN projects p ON p.id = r.project_id WHERE r.id=$1',
          [str(p.repoId)],
        )
      : cardId
        ? await one<{ id: string; org_id: string }>(
            db,
            'SELECT p.id, p.org_id FROM cards c JOIN projects p ON p.id = c.project_id WHERE c.id=$1',
            [cardId],
          )
        : null;
  return row ? { projectId: row.id, orgId: row.org_id, cardId } : null;
}
