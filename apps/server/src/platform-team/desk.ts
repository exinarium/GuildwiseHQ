import type { Ctx } from '../context.ts';
import { raiseOrCoalesce } from '../commands/desk-coalesce.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { getPlatformTeam } from './settings.ts';

export interface PlatformNotice {
  /** Identifies the subject: an open item with the same key takes a counter instead of a second item. */
  subjectKey: string;
  kind?: 'alert' | 'approval' | 'escalation';
  subkind: string;
  title: string;
  body: string;
  blocking?: boolean;
  pinned?: boolean;
  data?: Record<string, unknown>;
  /** The card the item is about (shown on the item). */
  cardId?: string;
  projectId?: string;
}

/**
 * Raises an item on the PLATFORM organisation's desk (never the super admin's: super admins have no desk), coalesced per
 * subject. Returns null when no platform team is designated: intake still records, nothing is raised.
 */
export async function notifyPlatformDesk(
  ctx: Ctx,
  n: PlatformNotice,
  opts: { tx?: Tx; extra?: AppendInput[] } = {},
): Promise<{ deskItemId: string; created: boolean; count: number } | null> {
  const team = await getPlatformTeam(opts.tx ?? ctx.pool);
  if (!team) return null;
  return raiseOrCoalesce(
    ctx,
    {
      subjectKey: n.subjectKey,
      orgId: team.orgId,
      kind: n.kind ?? 'alert',
      subkind: n.subkind,
      title: n.title,
      body: n.body,
      ...(n.blocking !== undefined ? { blocking: n.blocking } : {}),
      ...(n.pinned !== undefined ? { pinned: n.pinned } : {}),
      ...(n.cardId ? { cardId: n.cardId } : {}),
      ...(n.projectId ? { projectId: n.projectId } : {}),
      data: { ...(n.data ?? {}), platformTeam: true },
      actor: SYSTEM_ACTOR,
      scope: orgScope(team.orgId),
    },
    { ...(opts.tx ? { tx: opts.tx } : {}), ...(opts.extra ? { extra: opts.extra } : {}) },
  );
}
