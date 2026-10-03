import type { EventOf } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <
  T extends
    | 'IntakeStarted'
    | 'TicketMapped'
    | 'QuestionShiftDispatched'
    | 'QuestionRaised'
    | 'QuestionEscalated'
    | 'QuestionAnswered',
>(
  e: StoredEvent,
) => e.event as EventOf<T>;

interface AgentRef {
  name: string;
  role_key: string;
}
const agentOf = (tx: Tx, id: string | undefined) =>
  id ? one<AgentRef>(tx, 'SELECT name, role_key FROM agents WHERE id=$1', [id]) : Promise.resolve(undefined);

/** Appends one step to the desk item's escalation trail. */
async function addStep(tx: Tx, deskItemId: string, step: Record<string, unknown>): Promise<void> {
  await exec(tx, `UPDATE desk_items SET escalation_trail = escalation_trail || $2::jsonb WHERE id=$1`, [
    deskItemId,
    JSON.stringify([step]),
  ]);
}

export const intakeProjectors: Record<string, Projector> = {
  IntakeStarted: async (tx, e) => {
    const p = ev<'IntakeStarted'>(e).payload;
    const label = p.externalKey ?? (p.note ?? 'new request').replace(/\s+/g, ' ').slice(0, 60);
    await exec(
      tx,
      `INSERT INTO threads (id, org_id, project_id, card_id, kind, agent_id, title, created_by, created_at)
       VALUES ($1,$2,NULL,NULL,'intake',$3,$4,$5,$6)`,
      [p.threadId, e.scope.orgId, p.baAgentId, `Intake: ${label}`, p.startedBy, e.createdAt],
    );
    await exec(
      tx,
      `INSERT INTO intakes (id, org_id, thread_id, external_system, external_key, note, started_by, ba_agent_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        p.intakeId,
        e.scope.orgId,
        p.threadId,
        p.externalSystem ?? null,
        p.externalKey ?? null,
        p.note ?? null,
        p.startedBy,
        p.baAgentId,
        e.createdAt,
      ],
    );
  },

  TicketMapped: async (tx, e) => {
    const p = ev<'TicketMapped'>(e).payload;
    if (p.unmapped) {
      await exec(
        tx,
        `UPDATE intakes SET status='unmapped', mapping_desk_item_id=COALESCE($2, mapping_desk_item_id) WHERE id=$1`,
        [p.intakeId, p.deskItemId ?? null],
      );
    } else if (p.projectId) {
      await exec(tx, `UPDATE intakes SET status='mapped', mapped_project_id=$2 WHERE id=$1`, [
        p.intakeId,
        p.projectId,
      ]);
    }
    if (p.cardId) {
      await exec(
        tx,
        `INSERT INTO intake_cards (intake_id, card_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [p.intakeId, p.cardId, e.createdAt],
      );
    }
  },

  // The shift row of a question shift (like a DevOps shift it has no card claim).
  QuestionShiftDispatched: async (tx, e) => {
    const p = ev<'QuestionShiftDispatched'>(e).payload;
    const a = await one<{ org_id: string; runtime: string; model: string }>(
      tx,
      'SELECT org_id, runtime, model FROM agents WHERE id=$1',
      [p.agentId],
    );
    if (!a) return;
    await exec(
      tx,
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, runtime, model, overflow, started_at, desk_item_id)
       VALUES ($1,$2,$3,$4,NULL,'question',NULL,'starting',$5,$6,false,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [p.shiftId, a.org_id, p.agentId, p.workstationId, a.runtime, a.model, e.createdAt, p.deskItemId],
    );
  },

  // Runs after the desk projector inserted the item: the trail starts with the asker and the first route.
  QuestionRaised: async (tx, e) => {
    const p = ev<'QuestionRaised'>(e).payload;
    const asker = await agentOf(tx, p.askedBy.agentId);
    const at = e.createdAt.toISOString();
    await exec(tx, `UPDATE desk_items SET escalation_trail='[]' WHERE id=$1`, [p.deskItemId]);
    await addStep(tx, p.deskItemId, {
      at,
      step: 'asked',
      ...(p.askedBy.agentId ? { agentId: p.askedBy.agentId } : {}),
      ...(asker ? { agentName: asker.name, role: asker.role_key } : {}),
    });
    if (p.routedTo === 'agent' && p.routedAgentId) {
      const to = await agentOf(tx, p.routedAgentId);
      await addStep(tx, p.deskItemId, {
        at,
        step: p.chainLevel ?? 'peer',
        agentId: p.routedAgentId,
        ...(to ? { agentName: to.name, role: to.role_key } : {}),
      });
    }
  },

  QuestionEscalated: async (tx, e) => {
    const p = ev<'QuestionEscalated'>(e).payload;
    const to = await agentOf(tx, p.routedAgentId);
    await addStep(tx, p.deskItemId, {
      at: e.createdAt.toISOString(),
      step: p.routedTo === 'manager' ? 'desk' : (p.chainLevel ?? 'peer'),
      ...(p.routedAgentId ? { agentId: p.routedAgentId } : {}),
      ...(to ? { agentName: to.name, role: to.role_key } : {}),
      ...(p.note ? { note: p.note } : {}),
    });
  },

  QuestionAnswered: async (tx, e) => {
    const p = ev<'QuestionAnswered'>(e).payload;
    const by = await agentOf(tx, p.answeredBy.agentId);
    await addStep(tx, p.deskItemId, {
      at: e.createdAt.toISOString(),
      step: 'answered',
      ...(p.answeredBy.agentId ? { agentId: p.answeredBy.agentId } : {}),
      ...(by ? { agentName: by.name, role: by.role_key } : {}),
    });
    if (p.answeredBy.agentId)
      await exec(tx, 'UPDATE desk_items SET answered_by_agent_id=$2 WHERE id=$1', [
        p.deskItemId,
        p.answeredBy.agentId,
      ]);
  },
};
