import {
  BUILTIN_WORKFLOWS,
  frozenIdsOf,
  instantiateTemplate,
  WORKFLOW_TEMPLATES,
  type WorkflowDefinitionInput,
  WorkflowDefinitionSchema,
} from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  addField,
  appendStep,
  type BuilderModel,
  builderCaveats,
  describeDraft,
  freezeModel,
  fromDefinition,
  insertStepAfter,
  isLinear,
  moveStep,
  nextIndex,
  otherRoutes,
  removeField,
  removeStep,
  sendBackIndex,
  setNext,
  setSendBack,
  setStepKind,
  stepIds,
  syncKey,
  toDefinition,
  toggleRequired,
  updateField,
  updateStep,
  validateBuilder,
} from '../lib/builder.ts';
import { blankWorkflow } from '../lib/designer.ts';

const full = (d: ReturnType<typeof toDefinition>, over: { version: number; builtIn: boolean }) =>
  WorkflowDefinitionSchema.parse({ ...d, ...over });

function template(id: string): BuilderModel {
  const def = instantiateTemplate(id, { key: 'wf' }) as WorkflowDefinitionInput;
  return fromDefinition(def);
}
const step = (m: BuilderModel, uid: string) => {
  const s = m.steps.find((x) => x.uid === uid);
  if (!s) throw new Error(`no step ${uid}`);
  return s;
};

describe('toDefinition / fromDefinition round trip', () => {
  for (const wf of BUILTIN_WORKFLOWS) {
    it(`keeps the built-in workflow '${wf.key}' exactly`, () => {
      const back = toDefinition(fromDefinition(wf));
      expect(full(back, { version: wf.version, builtIn: wf.builtIn })).toEqual(wf);
    });
  }

  it('keeps the existing custom-workflow fixture (the designer blank) and every template', () => {
    const blank = { ...blankWorkflow(), version: 1, builtIn: false };
    expect(full(toDefinition(fromDefinition(blank)), { version: 1, builtIn: false })).toEqual(
      WorkflowDefinitionSchema.parse(blank),
    );
    for (const t of WORKFLOW_TEMPLATES) {
      const def = { ...t.definition, version: 1, builtIn: false };
      expect(full(toDefinition(fromDefinition(def)), { version: 1, builtIn: false })).toEqual(
        WorkflowDefinitionSchema.parse(def),
      );
    }
  });

  it('keeps a sub-workflow step, extra routes, guards and unknown stage settings', () => {
    const def = WorkflowDefinitionSchema.parse({
      key: 'x',
      version: 2,
      name: 'X',
      builtIn: false,
      fieldSet: 'custom',
      customFields: [{ key: 'urgent', label: 'Urgent', type: 'boolean', required: false }],
      cardTypes: ['support'],
      initialStage: 'a',
      stages: [
        {
          id: 'a',
          label: 'A',
          column: 'Inbox',
          kind: 'manual',
          claimRole: null,
          doneCriteria: '',
          outcomes: [
            { id: 'ready', label: 'Ready', kind: 'success', to: 'b', event: 'CardSpecified' },
            {
              id: 'fast',
              label: 'Fast lane',
              kind: 'success',
              to: 'c',
              event: 'StageCompleted',
              when: { field: 'urgent', equals: true },
            },
          ],
        },
        {
          id: 'b',
          label: 'B',
          column: 'B',
          kind: 'subworkflow',
          subworkflow: { workflowKey: 'other', mode: 'wait' },
          claimRole: null,
          doneCriteria: '',
          approvals: { small: 1, large: 2 },
          requiredCapabilities: ['gpu'],
          rebaseBefore: true,
          outcomes: [
            { id: 'done', label: 'Done', kind: 'success', to: 'c', event: 'StageCompleted' },
            { id: 'failed', label: 'Failed', kind: 'failure', to: 'a', event: 'StageCompleted' },
          ],
        },
        { id: 'c', label: 'C', column: 'Done', kind: 'terminal', claimRole: null, doneCriteria: '' },
      ],
    });
    expect(full(toDefinition(fromDefinition(def)), { version: 2, builtIn: false })).toEqual(def);
    const m = fromDefinition(def);
    expect(builderCaveats(m).join(' ')).toContain('more route');
    expect(otherRoutes(step(m, 'a')).map((o) => o.route.id)).toEqual(['fast']);
  });
});

describe('ids', () => {
  it('derives ids of new steps from their labels, unique, and keeps loaded ids when a label changes', () => {
    let m = template('simple-review');
    const loaded = m.steps.map((s) => s.uid);
    m = updateStep(m, loaded[1] as string, { label: 'Totally different name' });
    expect(stepIds(m).get(loaded[1] as string)).toBe(loaded[1]);
    const added = insertStepAfter(m, 1, 'Check the copy');
    const added2 = insertStepAfter(added.model, 1, 'Check the copy');
    const ids = stepIds(added2.model);
    expect([ids.get(added.uid), ids.get(added2.uid)].sort()).toEqual(['check_the_copy', 'check_the_copy_2']);
    // Renaming a not-yet-saved step re-derives its id.
    const renamed = updateStep(added2.model, added.uid, { label: 'Proofread' });
    expect(stepIds(renamed).get(added.uid)).toBe('proofread');
  });

  it('never re-derives frozen or saved ids, and never reuses a frozen id of a removed step', () => {
    const approved = instantiateTemplate('simple-review', { key: 'wf' }) as WorkflowDefinitionInput;
    const frozen = frozenIdsOf(approved);
    let m = fromDefinition(approved);
    const gone = m.steps[1]?.uid as string;
    m = removeStep(m, gone);
    const r = insertStepAfter(m, 0, 'Work');
    const ids = stepIds(r.model, frozen);
    // 'work' (or whichever id the removed step had) is reserved for the approved version.
    expect(ids.get(r.uid)).not.toBe(gone);
    const saved = freezeModel(r.model, frozen);
    expect(saved.steps.every((s) => s.id)).toBe(true);
    const renamed = updateStep(saved, r.uid, { label: 'Something else' });
    expect(stepIds(renamed, frozen).get(r.uid)).toBe(ids.get(r.uid));
  });

  it('derives field keys from labels and keeps routes and references pointing at them', () => {
    let m = template('blank');
    const f = addField(m);
    m = updateField(f.model, f.uid, { label: 'Order number', type: 'boolean' });
    const target = m.steps[1]?.uid as string;
    m = updateStep(m, target, { when: { field: f.uid, equals: true } });
    m = toggleRequired(m, target, f.uid, true);
    const def = toDefinition(m);
    expect(def.customFields?.[0]?.key).toBe('order_number');
    const stage = def.stages.find((s) => s.requiredFields?.includes('order_number'));
    expect(stage?.when).toEqual({ field: 'order_number', equals: true });
    // Removing the field clears every use.
    const without = toDefinition(removeField(m, f.uid));
    expect(without.customFields).toEqual([]);
    expect(without.stages.every((s) => !s.when && (s.requiredFields ?? []).length === 0)).toBe(true);
  });

  it('keeps the key following the name until saved, and never takes an existing key', () => {
    const m = template('blank');
    const taken = new Set(['code', 'my-flow', 'my_flow']);
    const named = syncKey({ ...m, name: 'My flow', keyFixed: false }, taken);
    expect(named.key).toBe('my_flow_2');
    expect(syncKey({ ...named, keyFixed: true, name: 'Renamed' }, taken).key).toBe('my_flow_2');
  });
});

describe('editing steps', () => {
  it('inserting a step after another re-routes the flow through it', () => {
    const m = template('blank');
    const first = m.steps[0]?.uid as string;
    const r = insertStepAfter(m, 0, 'Extra');
    const order = r.model.steps.map((s) => s.label);
    expect(order[1]).toBe('Extra');
    const firstStep = step(r.model, first);
    expect(firstStep.routes[nextIndex(firstStep)]?.to).toBe(r.uid);
    const extra = step(r.model, r.uid);
    expect(extra.routes[nextIndex(extra)]?.to).toBe(m.steps[1]?.uid);
    expect(isLinear(r.model)).toBe(true);
  });

  it('adds a step before the final one and chains it', () => {
    const m = template('simple-review');
    const r = appendStep(m, 'Late');
    const labels = r.model.steps.map((s) => s.label);
    expect(labels[labels.length - 1]).toBe('Finished');
    expect(labels[labels.length - 2]).toBe('Late');
    const late = step(r.model, r.uid);
    expect(r.model.steps.at(-1)?.uid).toBe(late.routes[nextIndex(late)]?.to);
    const validation = validateBuilder(r.model, { roles: [], departments: [] });
    expect(validation.issues.some((i) => i.code === 'unreachable_stage')).toBe(false);
  });

  it('removing a step reroutes what led into it; at least two steps remain', () => {
    const m = template('simple-review');
    const mid = m.steps[1]?.uid as string;
    const after = removeStep(m, mid);
    expect(after.steps.some((s) => s.uid === mid)).toBe(false);
    const first = after.steps[0] as BuilderModel['steps'][number];
    expect(first.routes[nextIndex(first)]?.to).toBe(m.steps[2]?.uid);
    // No route is left pointing at the removed step.
    expect(after.steps.flatMap((s) => s.routes.map((r) => r.to))).not.toContain(mid);
    const tiny = removeStep(removeStep(after, after.steps[1]?.uid as string), after.steps[0]?.uid as string);
    expect(tiny.steps.length).toBeGreaterThanOrEqual(1);
    expect(removeStep({ ...m, steps: m.steps.slice(0, 2) }, mid).steps).toHaveLength(2);
  });

  it('moving a step in a straight-line workflow keeps the flow in list order', () => {
    const m = appendStep(template('blank'), 'Second').model;
    expect(isLinear(m)).toBe(true);
    const mid = m.steps[1]?.uid as string;
    const moved = moveStep(m, mid, 1);
    expect(moved.steps.map((s) => s.label)).toEqual(['Request', 'Second', 'Work', 'Finished']);
    expect(isLinear(moved)).toBe(true);
    // The first step now leads to the one below it.
    const first = moved.steps[0] as BuilderModel['steps'][number];
    expect(first.routes[nextIndex(first)]?.to).toBe(moved.steps[1]?.uid);
  });

  it('moving a step when the flow is not a straight line only changes the order', () => {
    const m = template('simple-review');
    expect(isLinear(m)).toBe(false);
    const moved = moveStep(m, m.steps[1]?.uid as string, 1);
    expect(moved.steps.map((s) => s.uid)).toEqual(['request', 'review', 'work', 'finished']);
    expect(moved.steps.map((s) => s.routes)).toEqual(
      ['request', 'review', 'work', 'finished'].map((id) => m.steps.find((s) => s.uid === id)?.routes),
    );
  });

  it('sets "when finished" and "send back" routes, creating and removing them', () => {
    let m = template('blank');
    const work = m.steps[1] as BuilderModel['steps'][number];
    m = setSendBack(m, work.uid, m.steps[0]?.uid as string);
    let w = step(m, work.uid);
    expect(w.routes[sendBackIndex(w)]).toMatchObject({
      kind: 'failure',
      rework: true,
      event: 'StageCompleted',
    });
    m = setNext(m, work.uid, m.steps[2]?.uid as string);
    w = step(m, work.uid);
    expect(w.routes[nextIndex(w)]?.to).toBe(m.steps[2]?.uid);
    m = setSendBack(m, work.uid, null);
    expect(sendBackIndex(step(m, work.uid))).toBe(-1);
    // The first (manual) step's route is a "ready" route using CardSpecified.
    const start = step(setNext(m, m.steps[0]?.uid as string, work.uid), m.steps[0]?.uid as string);
    expect(start.routes[0]).toMatchObject({ id: 'specified', event: 'CardSpecified' });
  });

  it('turning a step into a final step drops its routes and role', () => {
    let m = template('simple-review');
    const mid = m.steps[1]?.uid as string;
    m = setStepKind(updateStep(m, mid, { role: 'writer' }), mid, 'terminal');
    expect(step(m, mid)).toMatchObject({ kind: 'terminal', role: null, routes: [] });
  });
});

describe('validateBuilder', () => {
  const role = (key: string, stage: string) =>
    ({
      key,
      name: key,
      version: 1,
      builtIn: false,
      purpose: 'p',
      instructions: 'i',
      coreRules: [],
      seniorityLevels: ['junior', 'senior'],
      defaultModel: { runtime: 'claude-code', model: 'sonnet' },
      permissions: {
        allowedTools: ['read'],
        deniedShellPatterns: [],
        writableGlobs: null,
        mayCommit: false,
        browser: false,
        readOnly: false,
        readOrgRepos: false,
        riskTiers: ['small', 'large'],
        repoIds: null,
      },
      skills: [],
      claimableStages: [{ workflowKey: 'wf', stageId: stage }],
    }) as never;

  it('words the issues in plain language and pins them on the step', () => {
    const m = syncKey({ ...template('simple-review'), name: 'Review' }, new Set());
    const v = validateBuilder(m, { roles: [], departments: [] });
    expect(v.errors).toBeGreaterThan(0);
    const work = v.byStage.get('work') ?? [];
    expect(work.some((i) => i.field === 'role' && /Pick a role/.test(i.text))).toBe(true);
    expect(v.issues.every((i) => !/stageId|\bundefined\b/.test(i.text))).toBe(true);
  });

  it('is clean once roles may take the steps; an empty name is a problem', () => {
    const m = { ...template('simple-review'), name: 'Review', key: 'wf' };
    const withRoles = updateStep(updateStep(m, 'work', { role: 'writer' }), 'review', { role: 'editor' });
    const roles = [role('writer', 'work'), role('editor', 'review')];
    const ok = validateBuilder(withRoles, { roles, departments: [] });
    expect(ok.errors).toBe(0);
    const unnamed = validateBuilder({ ...withRoles, name: '  ' }, { roles, departments: [] });
    expect(unnamed.issues.some((i) => i.code === 'name_missing')).toBe(true);
  });

  it('warns when an approved step disappears', () => {
    const approved = instantiateTemplate('simple-review', { key: 'wf' }) as WorkflowDefinitionInput;
    const m = removeStep(fromDefinition(approved), 'review');
    const v = validateBuilder(m, { roles: [], departments: [], frozen: frozenIdsOf(approved) });
    expect(v.issues.some((i) => i.code === 'frozen_id_removed' && i.severity === 'warning')).toBe(true);
  });

  it('prefers the server issues once a draft was saved', () => {
    const m = template('simple-review');
    const v = validateBuilder(m, { roles: [], departments: [] }, [
      {
        severity: 'error',
        code: 'unreachable_stage',
        message: "stage 'work' cannot be reached",
        stageId: 'work',
      },
    ]);
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]?.text).toMatch(/can never be reached/);
  });
});

describe('describeDraft', () => {
  it('outlines the steps for the BA chat', () => {
    const m = { ...template('simple-review'), name: 'Review' };
    const text = describeDraft(m, 'draft-1');
    expect(text).toContain('"Review"');
    expect(text).toContain('draft draft-1');
    expect(text).toMatch(/1\. /);
  });
});
