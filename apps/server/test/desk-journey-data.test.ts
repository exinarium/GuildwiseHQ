import { randomUUID } from 'node:crypto';
import { DeskItemDtoSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { toDeskDto } from '../src/queries/desk.ts';

// No database: the desk row is built by hand, as the desk query returns it.
const row = (subkind: string, data: Record<string, unknown> | null) => ({
  id: randomUUID(),
  org_id: randomUUID(),
  project_id: randomUUID(),
  kind: 'question',
  subkind,
  status: 'open',
  routed_to: 'manager',
  title: 'Journey',
  body: '',
  doing: '',
  options: [],
  recommendation: null,
  blocking: false,
  pinned: false,
  affected_card_ids: [],
  asked_by_kind: 'system',
  asked_by_agent_id: null,
  agent_name: null,
  asked_by_role: null,
  card_id: null,
  data,
  dedup_ledger_ids: [],
  answer: null,
  answer_option: null,
  answered_at: null,
  answered_by: null,
  answered_by_name: null,
  escalation_trail: [],
  triage: 'none',
  addressee_user_id: null,
  created_at: new Date('2026-11-04T10:00:00Z'),
  updated_at: new Date('2026-11-04T10:00:00Z'),
});

const dto = (r: ReturnType<typeof row>) => toDeskDto(r, randomUUID(), new Map(), new Map());

describe('desk DTO of journey items', () => {
  const waitId = randomUUID();
  const instanceId = randomUUID();
  const recordId = randomUUID();

  it('a gate item keeps the wait and the instance it acts on', () => {
    const out = dto(row('journey_gate', { waitId, instanceId, recordId, stepId: 'approval', role: 'owner' }));
    expect(out.data).toEqual({ waitId, instanceId, recordId, stepId: 'approval' });
  });

  it('an escalated wait keeps its kind, so an escalated gate hides "Continue the journey"', () => {
    const out = dto(
      row('journey_wait_escalated', { waitId, instanceId, recordId, stepId: 'approval', waitKind: 'gate' }),
    );
    expect(out.data).toEqual({ waitId, instanceId, recordId, stepId: 'approval', waitKind: 'gate' });
  });

  it('a link item keeps the wait and the link', () => {
    const linkId = randomUUID();
    const out = dto(row('journey_wait_link', { waitId, instanceId, recordId, linkId }));
    expect(out.data).toEqual({ waitId, instanceId, recordId, linkId });
  });

  it('the journey data passes the response schema', () => {
    const out = dto(
      row('journey_wait_escalated', { waitId, instanceId, recordId, stepId: 's', waitKind: 'duration' }),
    );
    const parsed = DeskItemDtoSchema.safeParse(out);
    expect(parsed.success ? parsed.data.data : parsed.error).toEqual({
      waitId,
      instanceId,
      recordId,
      stepId: 's',
      waitKind: 'duration',
    });
  });

  it('other items still pass on only their own data', () => {
    const out = dto(row('claude_auth_expired', { workstationId: 'ws-1', waitId, instanceId }));
    expect(out.data).toEqual({ workstationId: 'ws-1' });
    expect(dto(row('some_notice', { waitId })).data).toBeUndefined();
  });
});
