import { DESK_SUBKIND, streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Row } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';

export type JourneySubkind = 'journeyGate' | 'journeyWaitEscalated' | 'journeyWaitLink';

/** A question on the desk addressed to one user (gate, escalation) or a task (link). `data` holds ids only. */
export function deskQuestion(
  inst: Row,
  a: {
    deskItemId: string;
    subkind: JourneySubkind;
    doing: string;
    question: string;
    options: Array<{ id: string; label: string; description?: string }>;
    addresseeUserId: string;
    data: Record<string, unknown>;
  },
): AppendInput {
  return {
    streamId: streamId.desk(a.deskItemId),
    event: {
      type: 'QuestionRaised',
      payload: {
        deskItemId: a.deskItemId,
        projectId: inst.project_id,
        askedBy: { kind: 'system' },
        doing: a.doing,
        question: a.question,
        options: a.options,
        blocking: false,
        routedTo: 'manager',
        dedupLedgerIds: [],
        affectedCardIds: [],
        pinned: false,
        subkind: DESK_SUBKIND[a.subkind],
        addresseeUserId: a.addresseeUserId,
        data: a.data,
      },
    } as never,
    actor: SYSTEM_ACTOR,
    scope: projectScope(inst.org_id, inst.project_id),
  };
}

export function resolveDeskEvent(
  inst: Row,
  deskItemId: string,
  resolution: 'approved' | 'rejected' | 'acknowledged' | 'dismissed',
  note: string,
  byUserId?: string,
): AppendInput {
  return {
    streamId: streamId.desk(deskItemId),
    event: {
      type: 'DeskItemResolved',
      payload: {
        deskItemId,
        resolution,
        note,
        by: byUserId ? { kind: 'user', userId: byUserId } : { kind: 'system' },
      },
    },
    actor: byUserId ? userActor(byUserId) : SYSTEM_ACTOR,
    scope: projectScope(inst.org_id, inst.project_id),
  };
}
