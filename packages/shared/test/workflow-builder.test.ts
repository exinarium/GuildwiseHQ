import { describe, expect, it } from 'vitest';
import {
  assignIds,
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  CardOrigin,
  type CardTemplate,
  CardTemplateSchema,
  codeWorkflowV2,
  copyBuiltinAsCustom,
  DomainEventSchema,
  describeDiff,
  describePath,
  diffDefinitions,
  EXPLAINED_CODES,
  effectiveSubworkflowStart,
  expandMapping,
  explainIssue,
  explainIssues,
  frozenIdsOf,
  groupByStep,
  hasErrors,
  type IssueCode,
  idFromLabel,
  instantiateTemplate,
  isTriggerImplemented,
  missingFrozenIds,
  type RoleDefinition,
  researchWorkflowV1,
  ScheduleActionSchema,
  ScheduleTriggerSchema,
  StageSchema,
  type SubworkflowLookup,
  simulatePath,
  uniqueId,
  unknownMappingTokens,
  validateCustomWorkflow,
  validateWorkflow,
  WORKFLOW_TEMPLATES,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
  WorkflowDefinitionSchema,
} from '../src/index.ts';

const U = '018f0000-0000-7000-8000-00000000000a';
const ctx = { builtinWorkflowKeys: BUILTIN_WORKFLOWS.map((w) => w.key), departments: [] as string[] };

const role = (key: string): RoleDefinition => ({
  key,
  version: 1,
  name: key,
  purpose: 'p',
  department: 'support',
  builtIn: false,
  instructions: 'Do the work.',
  coreRules: [],
  seniorityLevels: ['junior', 'senior'],
  defaultModel: { runtime: 'claude-code', model: 'sonnet' },
  permissions: {
    allowedTools: ['read'],
    deniedShellPatterns: [],
    writableGlobs: null,
    mayCommit: false,
    browser: false,
    readOrgRepos: false,
    riskTiers: ['small', 'large'],
    repoIds: null,
  },
  skills: [],
  claimableStages: [{ workflowKey: '*', stageId: '*' }],
});
const ROLES = [...BUILTIN_ROLES, role('worker')];

const out = (id: string, to: string, kind: 'success' | 'failure' = 'success', extra = {}) => ({
  id,
  label: id,
  kind,
  to,
  event: 'StageCompleted',
  ...extra,
});
const stage = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  column: id,
  kind: 'agent',
  claimRole: 'worker',
  doneCriteria: 'done',
  outcomes: [],
  ...extra,
});
const wf = (key: string, stages: unknown[], over: Record<string, unknown> = {}): WorkflowDefinitionInput =>
  ({
    key,
    version: 1,
    name: key,
    builtIn: false,
    fieldSet: 'custom',
    customFields: [{ key: 'topic', label: 'Topic', type: 'text', required: true }],
    cardTypes: ['feature'],
    initialStage: (stages[0] as { id: string }).id,
    stages,
    ...over,
  }) as WorkflowDefinitionInput;

const sub = (id: string, key: string, over: Record<string, unknown> = {}, outs?: unknown[]) =>
  stage(id, {
    kind: 'subworkflow',
    claimRole: null,
    subworkflow: { workflowKey: key, ...over },
    outcomes: outs ?? [out('done', 'end'), out('failed', 'end', 'failure')],
  });
const end = { ...stage('end'), kind: 'terminal', claimRole: null };

const simple = (key: string, extra: Partial<WorkflowDefinitionInput> = {}) =>
  wf(key, [stage('a', { outcomes: [out('done', 'end')] }), end], extra);

const parent = (key: string, target: string, over: Record<string, unknown> = {}) =>
  wf(key, [sub('s', target, over), end]);

const target = (
  def: WorkflowDefinitionInput,
  over: Partial<{ approved: boolean; enabledInProject: boolean; sameOrg: boolean }> = {},
) => ({
  definition: WorkflowDefinitionSchema.parse(def),
  approved: true,
  enabledInProject: true,
  sameOrg: true,
  ...over,
});
const lookupOf =
  (defs: WorkflowDefinitionInput[], over = {}): SubworkflowLookup =>
  (key) => {
    const d = defs.find((x) => x.key === key);
    return d ? target(d, over) : undefined;
  };
const codes = (issues: Array<{ code: string; severity: string }>, sev = 'error') =>
  issues.filter((i) => i.severity === sev).map((i) => i.code);

describe('backward compatibility', () => {
  it('built-in workflows still parse and validate with no sub-workflow fields', () => {
    for (const w of BUILTIN_WORKFLOWS) {
      expect(hasErrors(validateWorkflow(w, BUILTIN_ROLES)), `${w.key} v${w.version}`).toBe(false);
      expect(w.stages.every((s) => s.subworkflow === undefined)).toBe(true);
    }
  });

  it('existing schedule triggers, actions and templates parse unchanged', () => {
    expect(ScheduleTriggerSchema.parse({ kind: 'event', event: 'card_finalized', projectId: U })).toEqual({
      kind: 'event',
      event: 'card_finalized',
      projectId: U,
    });
    const a = ScheduleActionSchema.parse({ kind: 'create_card', projectId: U, template: { title: 't' } });
    expect(a).toEqual({ kind: 'create_card', projectId: U, template: { title: 't', fields: {} } });
    expect(CardTemplateSchema.parse({ title: 'x' })).toEqual({ title: 'x', fields: {} });
  });

  it('parses the new sub-workflow events and card origins', () => {
    const started = DomainEventSchema.parse({
      type: 'SubworkflowStarted',
      payload: {
        cardId: U,
        stageId: 's',
        childCardId: U,
        childProjectId: U,
        workflowKey: 'c',
        workflowVersion: 2,
        mode: 'wait',
      },
    });
    expect(started.type === 'SubworkflowStarted' && started.payload.reworkRound).toBe(0);
    const resolved = DomainEventSchema.parse({
      type: 'SubworkflowResolved',
      payload: { cardId: U, stageId: 's', childCardId: U, result: 'cancelled' },
    });
    expect(resolved.type === 'SubworkflowResolved' && resolved.payload.fields).toEqual({});
    expect(
      DomainEventSchema.safeParse({
        type: 'SubworkflowRefused',
        payload: { cardId: U, stageId: 's', workflowKey: 'c', reason: 'depth' },
      }).success,
    ).toBe(true);
    for (const origin of ['subworkflow', 'trigger', 'email', 'manual'])
      expect(CardOrigin.safeParse(origin).success).toBe(true);
    expect(CardOrigin.safeParse('nope').success).toBe(false);
  });
});

describe('ids from labels', () => {
  it('slugs labels into valid ids', () => {
    expect(idFromLabel('Check the copy!')).toBe('check_the_copy');
    expect(idFromLabel('Écrire')).toBe('ecrire');
    expect(idFromLabel('3rd review')).toBe('step_3rd_review');
    expect(idFromLabel('???')).toBe('step');
    expect(idFromLabel('???', 'route')).toBe('route');
    for (const l of ['Check the copy!', '3rd review', '???', 'A-B c'])
      expect(idFromLabel(l)).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('makes ids unique', () => {
    expect(uniqueId('draft', new Set(['draft', 'draft_2']))).toBe('draft_3');
    const r = assignIds([{ label: 'Draft' }, { label: 'Draft' }, { label: 'draft' }]);
    expect(r.map((x) => x.id)).toEqual(['draft', 'draft_2', 'draft_3']);
  });

  it('keeps existing ids when a label is renamed, and frozen ids even when asked to re-derive', () => {
    const items = [
      { id: 'write', label: 'Write the text' },
      { id: 'edit', label: 'Proofread' },
      { label: 'Write the text' },
    ];
    expect(assignIds(items).map((i) => i.id)).toEqual(['write', 'edit', 'write_the_text']);
    expect(assignIds(items, { keepExisting: false, frozen: new Set(['write']) }).map((i) => i.id)).toEqual([
      'write',
      'proofread',
      'write_the_text',
    ]);
  });

  it('reports frozen ids a draft dropped', () => {
    const approved = wf('x', [
      stage('a', { outcomes: [out('done', 'b')] }),
      stage('b', { outcomes: [out('done', 'end')] }),
      end,
    ]);
    const frozen = frozenIdsOf(approved);
    expect(missingFrozenIds(frozen, approved)).toEqual([]);
    const draft = wf('x', [stage('a', { outcomes: [out('ok', 'end')] }), end]);
    expect(missingFrozenIds(frozen, draft).sort()).toEqual(['a.done', 'b']);
  });
});

describe('sub-workflow stage schema and validation', () => {
  it('defaults the config and keeps the kind optional-config-free for other kinds', () => {
    const s = StageSchema.parse(sub('s', 'child'));
    expect(s.subworkflow).toMatchObject({
      workflowKey: 'child',
      project: 'same',
      mode: 'wait',
      onFailure: 'fail',
      fieldsIn: [],
      fieldsOut: [],
    });
    expect(s.subworkflow?.start).toBeUndefined();
  });

  it('accepts a well formed sub-workflow stage', () => {
    expect(codes(validateWorkflow(parent('p', 'child'), ROLES))).toEqual([]);
  });

  it('flags missing config, stray config, a role, a missing failure route and bad mappings', () => {
    const noCfg = wf('p', [
      stage('s', { kind: 'subworkflow', claimRole: null, outcomes: [out('done', 'end')] }),
      end,
    ]);
    expect(codes(validateWorkflow(noCfg, ROLES))).toContain('subworkflow_missing_config');
    const stray = wf('p', [
      stage('s', { subworkflow: { workflowKey: 'c' }, outcomes: [out('done', 'end')] }),
      end,
    ]);
    expect(codes(validateWorkflow(stray, ROLES))).toContain('subworkflow_config_misplaced');
    const withRole = wf('p', [sub('s', 'c'), end]);
    (withRole.stages[0] as { claimRole: string | null }).claimRole = 'worker';
    expect(codes(validateWorkflow(withRole, ROLES))).toContain('subworkflow_has_role');
    const noFail = wf('p', [sub('s', 'c', {}, [out('done', 'end')]), end]);
    expect(codes(validateWorkflow(noFail, ROLES))).toContain('subworkflow_no_failed_route');
    const cont = wf('p', [sub('s', 'c', { onFailure: 'continue' }, [out('done', 'end')]), end]);
    expect(codes(validateWorkflow(cont, ROLES))).toEqual([]);
    const dup = parent('p', 'c', {
      fieldsIn: [
        { to: 'x', from: { value: 1 } },
        { to: 'x', from: { value: 2 } },
      ],
    });
    expect(codes(validateWorkflow(dup, ROLES))).toContain('subworkflow_duplicate_mapping');
    const unk = parent('p', 'c', { fieldsIn: [{ to: 'x', from: { field: 'nope' } }] });
    expect(codes(validateWorkflow(unk, ROLES))).toContain('subworkflow_unknown_field');
    const back = parent('p', 'c', { mode: 'continue', fieldsOut: [{ to: 'topic', from: 'topic' }] });
    expect(codes(validateWorkflow(back, ROLES))).toContain('subworkflow_field_out_in_continue');
  });

  it('validates targets: unknown, unapproved, not enabled, other org', () => {
    const child = simple('child');
    const p = parent('p', 'child');
    expect(codes(validateCustomWorkflow(p, ROLES, { ...ctx, subworkflowLookup: lookupOf([child]) }))).toEqual(
      [],
    );
    expect(codes(validateCustomWorkflow(p, ROLES, { ...ctx, subworkflowLookup: lookupOf([]) }))).toContain(
      'subworkflow_unknown_target',
    );
    const c = (o: object) =>
      codes(validateCustomWorkflow(p, ROLES, { ...ctx, subworkflowLookup: lookupOf([child], o) }));
    expect(c({ approved: false })).toContain('subworkflow_target_not_approved');
    expect(c({ enabledInProject: false })).toContain('subworkflow_target_not_enabled');
    expect(c({ sameOrg: false })).toContain('subworkflow_cross_org');
  });

  it('without a lookup only the target-independent rules run', () => {
    expect(codes(validateCustomWorkflow(parent('p', 'ghost'), ROLES, ctx))).toEqual([]);
  });

  it('checks mapped fields: existence and type compatibility', () => {
    const child = simple('child', {
      customFields: [
        { key: 'flag', label: 'Flag', type: 'boolean', required: false },
        { key: 'note', label: 'Note', type: 'text', required: true },
      ],
    });
    const run = (over: Record<string, unknown>) =>
      validateCustomWorkflow(parent('p', 'child', over), ROLES, {
        ...ctx,
        subworkflowLookup: lookupOf([child]),
      });
    expect(codes(run({ fieldsIn: [{ to: 'note', from: { field: 'topic' } }] }))).toEqual([]);
    expect(codes(run({ fieldsIn: [{ to: 'ghost', from: { field: 'topic' } }] }))).toContain(
      'subworkflow_unknown_field',
    );
    expect(codes(run({ fieldsIn: [{ to: 'flag', from: { field: 'topic' } }] }))).toContain(
      'subworkflow_field_type',
    );
    expect(codes(run({ fieldsIn: [{ to: 'flag', from: { template: 'x {card.ref}' } }] }))).toContain(
      'subworkflow_field_type',
    );
    expect(codes(run({ fieldsIn: [{ to: 'flag', from: { value: 'yes' } }] }))).toContain(
      'subworkflow_field_type',
    );
    expect(codes(run({ fieldsIn: [{ to: 'flag', from: { value: true } }] }))).toEqual([]);
    expect(codes(run({ fieldsOut: [{ to: 'topic', from: 'ghost' }] }))).toContain(
      'subworkflow_unknown_field',
    );
    expect(codes(run({ cardType: 'bug' }))).toContain('subworkflow_unknown_card_type');
    const warn = codes(run({ start: 'queued' }), 'warning');
    expect(warn).toContain('subworkflow_required_unmapped');
    expect(
      codes(run({ start: 'queued', fieldsIn: [{ to: 'note', from: { value: 'x' } }] }), 'warning'),
    ).not.toContain('subworkflow_required_unmapped');
  });

  it('refuses self reference and cycles of any length', () => {
    const self = parent('p', 'p');
    expect(
      codes(validateCustomWorkflow(self, ROLES, { ...ctx, subworkflowLookup: lookupOf([self]) })),
    ).toContain('subworkflow_cycle');
    const a = parent('a', 'b');
    const b = parent('b', 'c');
    const c = parent('c', 'a');
    const issues = validateCustomWorkflow(a, ROLES, { ...ctx, subworkflowLookup: lookupOf([a, b, c]) });
    expect(codes(issues)).toContain('subworkflow_cycle');
    expect(issues.find((i) => i.code === 'subworkflow_cycle')?.message).toContain('a -> b -> c -> a');
  });

  it('allows depth 3 and refuses depth 4', () => {
    const l3 = simple('l3');
    const l2 = parent('l2', 'l3');
    const l1 = parent('l1', 'l2');
    const root = parent('root', 'l1'); // root -> l1 -> l2 -> l3: three levels below it
    const run = (defs: WorkflowDefinitionInput[], r: WorkflowDefinitionInput) =>
      validateCustomWorkflow(r, ROLES, { ...ctx, subworkflowLookup: lookupOf(defs) });
    expect(codes(run([l1, l2, l3], root))).toEqual([]);
    const l0 = parent('l0', 'root'); // four levels
    expect(codes(run([root, l1, l2, l3], l0))).toContain('subworkflow_too_deep');
  });

  it('computes the effective start state', () => {
    const cfg = { fieldsIn: [{ to: 'a', from: { value: 1 } }] };
    expect(effectiveSubworkflowStart({ ...cfg }, ['a'])).toBe('queued');
    expect(effectiveSubworkflowStart({ ...cfg }, ['a', 'b'])).toBe('draft');
    expect(effectiveSubworkflowStart({ ...cfg, start: 'draft' }, ['a'])).toBe('draft');
  });
});

describe('explain', () => {
  it('has wording for every issue code and pins it on the step', () => {
    const doc: WorkflowDefinitionInput = wf('x', [
      stage('check', { label: 'Check', claimRole: null, outcomes: [] }),
      end,
    ]);
    const issues = validateWorkflow(doc, ROLES);
    const e = explainIssues(issues, doc);
    const noRole = e.find((x) => x.code === 'agent_stage_without_role');
    expect(noRole).toMatchObject({ stageId: 'check', field: 'role' });
    expect(noRole?.text).toBe("Step 'Check' has no role that may work it. Pick a role or create one.");
    expect(e.every((x) => x.text.length > 0)).toBe(true);
    const g = groupByStep(e);
    expect(g.get('check')?.length).toBeGreaterThan(0);
  });

  it('covers the whole IssueCode union (compile time) and every code yields a sentence', () => {
    for (const code of EXPLAINED_CODES) {
      const x = explainIssue({
        severity: 'error',
        rule: 0,
        code,
        message: "stage 'a' role 'r' field 'f'",
        stageId: 'a',
      });
      expect(x.text, code).toMatch(/\S/);
      expect(x.text, code).not.toContain('undefined');
    }
    const all: readonly IssueCode[] = EXPLAINED_CODES;
    expect(all).toContain('subworkflow_cycle');
    expect(new Set(all).size).toBe(all.length);
  });

  it('names roles and fields from the validator message', () => {
    const x = explainIssue(
      {
        severity: 'error',
        rule: 3,
        code: 'unknown_role',
        message: "stage 'a' names unknown role 'poet'",
        stageId: 'a',
      },
      {
        stages: [
          {
            id: 'a',
            label: 'Write',
            column: 'w',
            kind: 'agent',
            claimRole: 'poet',
            doneCriteria: '',
            outcomes: [],
          },
        ],
      },
    );
    expect(x.text).toContain("Step 'Write'");
    expect(x.text).toContain("'poet'");
  });
});

describe('simulatePath', () => {
  const flow = WorkflowDefinitionSchema.parse(
    wf(
      'flow',
      [
        stage('draft', { outcomes: [out('done', 'check')] }),
        stage('check', {
          outcomes: [out('ok', 'end'), out('rework', 'draft', 'failure', { rework: true })],
        }),
        end,
      ],
      { customFields: [] },
    ),
  );

  it('follows the first success route and reports defaults', () => {
    const r = simulatePath(flow, {});
    expect(r.end).toBe('finished');
    expect(r.path).toEqual(['draft', 'check', 'end']);
    expect(r.firstDefaulted).toBe(0);
    expect(describePath(r)).toBe('1. draft (worker) -> 2. check (worker) -> 3. end');
  });

  it('honours explicit choices, in order or by step id', () => {
    const fail = simulatePath(flow, {}, ['done', 'rework', 'done', 'ok']);
    expect(fail.path).toEqual(['draft', 'check', 'draft', 'check', 'end']);
    expect(fail.firstDefaulted).toBe(-1);
    const byStage = simulatePath(flow, {}, { check: 'ok' });
    expect(byStage.end).toBe('finished');
    expect(byStage.steps[1]?.defaulted).toBe(false);
    expect(byStage.steps[1]?.offered.map((o) => o.id)).toEqual(['ok', 'rework']);
  });

  it('detects loops and bad choices', () => {
    const loop = simulatePath(flow, {}, { check: 'rework' }, { maxVisits: 3 });
    expect(loop.end).toBe('loop');
    const bad = simulatePath(flow, {}, ['nope']);
    expect(bad.end).toBe('error');
    expect(bad.error).toContain("'nope'");
  });

  it('skips inactive steps and applies outcome guards', () => {
    const f = WorkflowDefinitionSchema.parse(
      wf(
        'g',
        [
          stage('a', { outcomes: [out('done', 'opt')] }),
          stage('opt', { when: { field: 'docsNeeded', equals: true }, outcomes: [out('done', 'end')] }),
          end,
        ],
        { customFields: [] },
      ),
    );
    const off = simulatePath(f, { docsNeeded: false });
    expect(off.steps.map((s) => [s.stageId, s.skipped])).toEqual([
      ['a', false],
      ['opt', true],
      ['end', false],
    ]);
    expect(simulatePath(f, { docsNeeded: true }).steps.some((s) => s.skipped)).toBe(false);
    const guarded = WorkflowDefinitionSchema.parse(
      wf(
        'h',
        [
          stage('a', {
            outcomes: [
              out('d1', 'end', 'success', { when: { field: 'docsNeeded', equals: true } }),
              out('d2', 'end', 'success', { when: { field: 'docsNeeded', equals: false } }),
            ],
          }),
          end,
        ],
        { customFields: [] },
      ),
    );
    expect(simulatePath(guarded, { docsNeeded: true }).steps[0]?.offered.map((o) => o.id)).toEqual(['d1']);
    expect(simulatePath(guarded, { docsNeeded: true }, ['d2']).end).toBe('error');
  });

  it('walks every built-in workflow to a final step', () => {
    for (const w of BUILTIN_WORKFLOWS) {
      const r = simulatePath(w, { docsNeeded: true });
      expect(r.end, `${w.key} v${w.version}`).toBe('finished');
    }
  });
});

describe('diffDefinitions', () => {
  const base = WorkflowDefinitionSchema.parse(
    wf('d', [
      stage('a', { outcomes: [out('done', 'b')] }),
      stage('b', { outcomes: [out('done', 'end')] }),
      end,
    ]),
  );

  it('reports identical definitions', () => {
    const d = diffDefinitions(base, structuredClone(base));
    expect(d.identical).toBe(true);
    expect(describeDiff(d)).toEqual([]);
  });

  it('reports added, removed and changed steps, routes, fields and meta', () => {
    const next = structuredClone(base);
    next.name = 'Renamed';
    next.stages[0] = {
      ...next.stages[0]!,
      doneCriteria: 'new',
      outcomes: [{ ...next.stages[0]!.outcomes[0]!, to: 'c' }],
    };
    next.stages.splice(1, 1, { ...stage('c', { outcomes: [out('done', 'end')] }) } as never);
    next.customFields = [{ key: 'x', label: 'X', type: 'text', required: false }];
    const d = diffDefinitions(base, WorkflowDefinitionSchema.parse(next));
    expect(d.identical).toBe(false);
    expect(d.stages.map((s) => `${s.stageId}:${s.change}`).sort()).toEqual([
      'a:changed',
      'b:removed',
      'c:added',
    ]);
    expect(d.stages.find((s) => s.stageId === 'a')).toMatchObject({
      props: ['doneCriteria'],
      routes: [{ outcomeId: 'done', change: 'changed', props: ['to'] }],
    });
    expect(d.fieldsAdded).toEqual(['x']);
    expect(d.fieldsRemoved).toEqual(['topic']);
    expect(d.meta).toEqual(['name']);
    expect(describeDiff(d)).toContain("Added step 'c'");
  });

  it('detects a reordered step', () => {
    const next = structuredClone(base);
    next.stages = [next.stages[1]!, next.stages[0]!, next.stages[2]!];
    expect(diffDefinitions(base, next).moved).toEqual(['b', 'a']);
  });
});

describe('templates', () => {
  it.each(WORKFLOW_TEMPLATES.map((t) => [t.id, t] as const))(
    '%s is a valid custom workflow once roles are picked',
    (_id, t) => {
      const def = instantiateTemplate(t.id, { key: 'mine' }) as WorkflowDefinitionInput;
      expect(def.key).toBe('mine');
      // Fresh template: every agent step asks for a role.
      const fresh = validateCustomWorkflow(def, ROLES, ctx);
      expect(codes(fresh).filter((c) => c !== 'agent_stage_without_role')).toEqual([]);
      expect(Object.keys(t.roleHints).sort()).toEqual(
        def.stages
          .filter((s) => s.kind === 'agent')
          .map((s) => s.id)
          .sort(),
      );
      for (const s of def.stages) if (s.kind === 'agent') s.claimRole = 'worker';
      expect(codes(validateCustomWorkflow(def, ROLES, ctx))).toEqual([]);
      expect(codes(validateCustomWorkflow(def, ROLES, ctx), 'warning')).toEqual([]);
    },
  );

  it('instances are independent copies', () => {
    const a = instantiateTemplate('blank', { key: 'a' }) as WorkflowDefinitionInput;
    a.stages[0]!.label = 'changed';
    expect(instantiateTemplate('blank', { key: 'b' })?.stages[0]?.label).toBe('Request');
    expect(instantiateTemplate('missing', { key: 'b' })).toBeUndefined();
  });

  it('copies built-ins as custom workflows and lists what was lost', () => {
    for (const b of [codeWorkflowV2, researchWorkflowV1]) {
      const { definition, notices } = copyBuiltinAsCustom(b, { key: `copy-${b.key}` });
      expect(definition.builtIn).toBe(false);
      expect(notices.length).toBeGreaterThan(0);
      const issues = validateCustomWorkflow(definition, ROLES, ctx);
      // Roles of the built-in do not claim the copy's steps: that is the only thing left to fix.
      expect(
        codes(issues).filter((c) => c !== 'role_cannot_claim_stage' && c !== 'unknown_role'),
        b.key,
      ).toEqual([]);
    }
    expect(copyBuiltinAsCustom(codeWorkflowV2, { key: 'c' }).notices.join(' ')).toMatch(
      /spawn_bug_child|not carried over/,
    );
  });
});

describe('schedule schema extensions', () => {
  it('parses the new trigger kinds and event filters', () => {
    expect(
      ScheduleTriggerSchema.parse({
        kind: 'event',
        event: 'card_stage_reached',
        workflowKey: 'support',
        stageId: 'check',
        filter: { cardType: 'support', fieldEquals: [{ field: 'urgent', equals: true }] },
      }),
    ).toMatchObject({ workflowKey: 'support', stageId: 'check' });
    expect(
      ScheduleTriggerSchema.safeParse({ kind: 'email_received', inboxId: U, from: ['@acme.com'] }).success,
    ).toBe(true);
    expect(ScheduleTriggerSchema.safeParse({ kind: 'email_reply', inboxId: U }).success).toBe(true);
    expect(ScheduleTriggerSchema.safeParse({ kind: 'intake_ticket', source: 'email' }).success).toBe(true);
    expect(ScheduleTriggerSchema.safeParse({ kind: 'webhook_in', secretHash: 'h' }).success).toBe(true);
    expect(ScheduleTriggerSchema.safeParse({ kind: 'email_received' }).success).toBe(false);
  });

  it('only the triggers the server fires are marked implemented', () => {
    expect(isTriggerImplemented({ kind: 'manual' })).toBe(true);
    expect(isTriggerImplemented({ kind: 'event', event: 'card_finalized' })).toBe(true);
    expect(isTriggerImplemented({ kind: 'event', event: 'card_stage_reached' })).toBe(true);
    expect(isTriggerImplemented({ kind: 'intake_ticket' })).toBe(true);
    expect(isTriggerImplemented({ kind: 'intake_ticket', source: 'email' })).toBe(false);
    expect(isTriggerImplemented({ kind: 'email_reply', inboxId: U })).toBe(false);
  });

  it('create_card gains mapping, start, rate and dedupe (all optional)', () => {
    const a = ScheduleActionSchema.parse({
      kind: 'create_card',
      projectId: U,
      template: { title: '{email.subject}', mapping: { context: '{email.body}' }, start: 'draft' },
      ratePerHour: 5,
      dedupe: 'thread',
    });
    expect(a.kind === 'create_card' && (a.template as CardTemplate).start).toBe('draft');
    expect(
      ScheduleActionSchema.safeParse({
        kind: 'create_card',
        projectId: U,
        template: { title: 't' },
        ratePerHour: 0,
      }).success,
    ).toBe(false);
  });

  it('expands mapping tokens once and flags unknown ones', () => {
    const v = { 'email.subject': 'Hello {card.ref}', 'email.from': 'a@b.c', 'card.fields.order': '77' };
    expect(
      expandMapping('Re: {email.subject} from {email.from} #{card.fields.order} {nope} {card.ref}', v),
    ).toBe('Re: Hello {card.ref} from a@b.c #77 {nope} ');
    expect(unknownMappingTokens({ title: '{email.subject}', context: '{bogus} {card.fields.x}' })).toEqual([
      'bogus',
    ]);
  });
});
