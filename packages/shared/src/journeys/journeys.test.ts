import { describe, expect, it } from 'vitest';
import { DomainEventSchema } from '../events/index.ts';
import {
  conditionHolds,
  expandRecordTemplate,
  type HandoffContext,
  JOURNEY_TEMPLATES,
  JourneyDefinitionSchema,
  JourneyRecordDtoSchema,
  JourneyReferenceInputSchema,
  nextMove,
  RECORD_COLUMNS,
  resolveHandoff,
  validateJourney,
} from '../index.ts';

const ctx = (over: Partial<HandoffContext> = {}): HandoffContext => ({
  result: 'done',
  card: { fields: { approved: true, rooms: 3, note: '' } },
  record: { type: 'client', status: 'active' },
  visits: 1,
  ...over,
});

const def = JourneyDefinitionSchema.parse({
  name: 'J',
  recordType: 'client',
  firstStepId: 'a',
  steps: [
    { kind: 'workflow', id: 'a', label: 'A', workflowKey: 'w' },
    { kind: 'workflow', id: 'b', label: 'B', workflowKey: 'w' },
    { kind: 'workflow', id: 'c', label: 'C', workflowKey: 'w' },
  ],
  handoffs: [
    {
      id: 'h1',
      from: 'a',
      on: 'done',
      to: 'b',
      condition: { source: 'card', field: 'approved', op: 'equals', value: true },
    },
    { id: 'h2', from: 'a', on: 'any', to: 'c' },
    {
      id: 'h3',
      from: 'b',
      on: 'done',
      to: 'b',
      condition: { source: 'record', field: 'visits', op: 'lt', value: 3 },
    },
    { id: 'h4', from: 'b', on: 'done', to: 'end' },
    { id: 'h5', from: 'c', on: 'done', to: 'a' },
  ],
});

describe('conditions', () => {
  it('reads card fields, record metadata and treats a missing boolean as false', () => {
    expect(conditionHolds({ source: 'card', field: 'rooms', op: 'gte', value: 3 }, ctx())).toBe(true);
    expect(conditionHolds({ source: 'card', field: 'rooms', op: 'lt', value: 3 }, ctx())).toBe(false);
    expect(conditionHolds({ source: 'card', field: 'note', op: 'is_not_set' }, ctx())).toBe(true);
    expect(conditionHolds({ source: 'card', field: 'missing', op: 'is_set' }, ctx())).toBe(false);
    expect(conditionHolds({ source: 'card', field: 'flag', op: 'equals', value: false }, ctx())).toBe(true);
    expect(conditionHolds({ source: 'record', field: 'type', op: 'equals', value: 'client' }, ctx())).toBe(
      true,
    );
    expect(conditionHolds({ source: 'card', field: 'x', op: 'is_set' }, ctx({ card: null }))).toBe(false);
  });
});

describe('handoffs', () => {
  it('takes the first matching handoff by order', () => {
    expect(resolveHandoff(def, 'a', ctx())?.id).toBe('h1');
    expect(resolveHandoff(def, 'a', ctx({ card: { fields: { approved: false } } }))?.id).toBe('h2');
    expect(resolveHandoff(def, 'a', ctx({ result: 'cancelled' }))?.id).toBe('h2');
  });
  it('follows a loop while the condition holds, then ends', () => {
    expect(nextMove(def, 'b', ctx({ visits: 2 }))).toMatchObject({ kind: 'next', handoff: { to: 'b' } });
    expect(nextMove(def, 'b', ctx({ visits: 3 }))).toEqual({ kind: 'end' });
  });
  it('a step with no handoffs ends the instance; handoffs with no match are stuck', () => {
    const d = JourneyDefinitionSchema.parse({
      ...def,
      handoffs: [{ id: 'x', from: 'a', on: 'cancelled', to: 'b' }],
    });
    expect(nextMove(d, 'b', ctx())).toEqual({ kind: 'end' });
    expect(nextMove(d, 'a', ctx()).kind).toBe('stuck');
  });
});

describe('validation', () => {
  it('accepts the sample and reports problems with stable codes', () => {
    expect(validateJourney(def).errors).toEqual([]);
    const bad = JourneyDefinitionSchema.parse({
      ...def,
      steps: [...def.steps, { kind: 'workflow', id: 'a', label: 'dup', workflowKey: null }],
      handoffs: [
        { id: 'h1', from: 'a', to: 'zzz' },
        { id: 'h1', from: 'q', to: 'b' },
      ],
    });
    const codes = validateJourney(bad, { enabledWorkflowKeys: ['other'] }).errors.map((e) => e.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'duplicate_step',
        'duplicate_handoff',
        'unknown_from',
        'unknown_to',
        'no_workflow',
        'workflow_not_enabled',
      ]),
    );
  });
  it('refuses a loop made only of placeholders', () => {
    const d = JourneyDefinitionSchema.parse({
      name: 'P',
      recordType: 'deal',
      firstStepId: 'w1',
      steps: [
        { kind: 'wait', id: 'w1', label: 'W' },
        { kind: 'gate', id: 'g1', label: 'G' },
      ],
      handoffs: [
        { id: 'a', from: 'w1', to: 'g1' },
        { id: 'b', from: 'g1', to: 'w1' },
      ],
    });
    expect(validateJourney(d).errors.map((e) => e.code)).toContain('placeholder_cycle');
  });
  it('fills record templates', () => {
    expect(
      expandRecordTemplate('{step.label}: {record.name} ({record.externalId}) {nope}', {
        name: 'Ann',
        type: 'client',
        externalId: null,
        stepLabel: 'Lead',
      }),
    ).toBe('Lead: Ann () {nope}');
  });
});

describe('definition round trip', () => {
  it('parses what it stored unchanged', () => {
    const again = JourneyDefinitionSchema.parse(JSON.parse(JSON.stringify(def)));
    expect(again).toEqual(def);
  });
});

describe('rentals template', () => {
  const t = JOURNEY_TEMPLATES.find((x) => x.id === 'rentals');
  it('has the ten steps in order, two placeholders and the monthly loop', () => {
    expect(t?.definition.steps.map((s) => s.id)).toEqual([
      'lead',
      'viewing',
      'application',
      'wait_documents',
      'screening',
      'approval',
      'lease_signed',
      'deposit_invoice',
      'move_in',
      'monthly_rent',
    ]);
    expect(t?.definition.steps.filter((s) => s.kind !== 'workflow').map((s) => s.kind)).toEqual([
      'wait',
      'gate',
    ]);
    expect(t?.definition.handoffs.find((h) => h.from === 'monthly_rent' && h.on === 'done')?.to).toBe(
      'monthly_rent',
    );
    expect(
      validateJourney(t!.definition, {
        enabledWorkflowKeys: new Set(
          t!.definition.steps.flatMap((s) => (s.kind === 'workflow' && s.workflowKey ? [s.workflowKey] : [])),
        ),
      }).errors,
    ).toEqual([]);
  });
  it('walks from lead to the loop', () => {
    const d = t!.definition;
    expect(nextMove(d, 'lead', ctx()).kind).toBe('next');
    expect(nextMove(d, 'lead', ctx({ result: 'cancelled' }))).toEqual({ kind: 'end' });
    expect(nextMove(d, 'wait_documents', ctx({ card: null }))).toMatchObject({
      kind: 'next',
      handoff: { to: 'screening' },
    });
    expect(nextMove(d, 'monthly_rent', ctx())).toMatchObject({
      kind: 'next',
      handoff: { to: 'monthly_rent' },
    });
  });
});

describe('the record holds no content', () => {
  const rec = {
    id: crypto.randomUUID(),
    orgId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    type: 'client',
    externalId: null,
    displayName: 'Ann',
    status: 'active',
    currentInstanceId: null,
    currentStepId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    references: [],
  };
  it('refuses unknown keys on the record and on references', () => {
    expect(JourneyRecordDtoSchema.safeParse(rec).success).toBe(true);
    expect(JourneyRecordDtoSchema.safeParse({ ...rec, answers: { q: 'a' } }).success).toBe(false);
    expect(JourneyRecordDtoSchema.safeParse({ ...rec, documents: [{ content: 'x' }] }).success).toBe(false);
    expect(
      JourneyReferenceInputSchema.safeParse({ kind: 'document', ref: 's3://b/k', content: 'x' }).success,
    ).toBe(false);
    expect(
      JourneyReferenceInputSchema.safeParse({ kind: 'document', ref: 'data:text/plain;base64,AAAA' }).success,
    ).toBe(false);
    expect(JourneyReferenceInputSchema.safeParse({ kind: 'document', ref: 'two words' }).success).toBe(false);
  });
  it('the record columns are the allow-list', () => {
    expect([...RECORD_COLUMNS].sort()).toEqual(
      [
        'created_at',
        'current_instance_id',
        'current_step_id',
        'display_name',
        'external_id',
        'id',
        'org_id',
        'project_id',
        'record_type',
        'status',
        'updated_at',
      ].sort(),
    );
  });
  it('record events carry only allow-listed keys', () => {
    const keys = (type: string): string[] => {
      const opt = (DomainEventSchema as any).options.find((o: any) => o.shape.type.value === type);
      return Object.keys(opt.shape.payload.shape).sort();
    };
    expect(keys('JourneyRecordCreated')).toEqual([
      'displayName',
      'externalId',
      'orgId',
      'projectId',
      'recordId',
      'recordType',
    ]);
    expect(keys('JourneyRecordReferenceAdded')).toEqual(['kind', 'label', 'recordId', 'ref']);
  });
});
