import {
  fieldCatalogue,
  instantiateTemplate,
  requiredChildFields,
  type SubworkflowTargetsResponse,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
  WorkflowDefinitionSchema,
} from '@aom/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { SubworkflowEditor } from '../components/builder/SubworkflowEditor.tsx';
import { WorkflowBuilder } from '../components/builder/WorkflowBuilder.tsx';
import {
  addField,
  type BuilderModel,
  fromDefinition,
  removeField,
  syncKey,
  toDefinition,
  updateField,
  validateBuilder,
} from '../lib/builder.ts';
import { buildSubworkflowLookup, configOf } from '../lib/subworkflowStep.ts';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const WEB = ID(1);
const SUP = ID(2);

/** The workflow the steps start: a customer (needed), a reply, a glossary list and a yes/no flag. */
const TRANSLATE: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  key: 'translate',
  name: 'Translate',
  version: 1,
  builtIn: false,
  fieldSet: 'custom',
  customFields: [
    { key: 'customer', label: 'Customer', type: 'text', required: true },
    { key: 'reply', label: 'Reply', type: 'markdown', required: false },
    { key: 'glossary', label: 'Glossary', type: 'list', required: false },
    { key: 'urgent', label: 'Urgent', type: 'boolean', required: false },
  ],
  cardTypes: ['feature', 'support'],
  initialStage: 'intake',
  stages: [
    {
      id: 'intake',
      label: 'Intake',
      column: 'Intake',
      kind: 'manual',
      claimRole: null,
      doneCriteria: 'x',
      outcomes: [{ id: 'ready', label: 'Ready', kind: 'success', to: 'work', event: 'CardSpecified' }],
    },
    {
      id: 'work',
      label: 'Work',
      column: 'Work',
      kind: 'agent',
      claimRole: 'translator',
      doneCriteria: 'x',
      outcomes: [{ id: 'ok', label: 'Ok', kind: 'success', to: 'fin', event: 'StageCompleted' }],
    },
    {
      id: 'fin',
      label: 'Fin',
      column: 'Fin',
      kind: 'terminal',
      claimRole: null,
      doneCriteria: '',
      outcomes: [],
    },
  ],
});

const targetsFor = (defs: WorkflowDefinition[]): SubworkflowTargetsResponse => ({
  workflows: defs.map((d) => {
    const required = new Set(requiredChildFields(d));
    return {
      key: d.key,
      name: d.name,
      builtIn: false,
      cardTypes: d.cardTypes,
      fields: Object.entries(fieldCatalogue(d.fieldSet, d.customFields)).map(([key, m]) => ({
        key,
        label: m.label,
        kind: m.kind,
        required: required.has(key),
      })),
    };
  }),
  projects: [
    { id: WEB, key: 'WEB', name: 'Web', enabledWorkflows: ['translate'] },
    { id: SUP, key: 'SUP', name: 'Support', enabledWorkflows: [] },
  ],
});
const TARGETS = targetsFor([TRANSLATE]);
const LOOKUP = buildSubworkflowLookup(
  {
    workflows: [
      { key: 'translate', builtIn: false, versions: [{ status: 'active', definition: TRANSLATE }] },
    ],
  } as never,
  TARGETS,
);

const ROLES = [
  {
    key: 'doer',
    name: 'Doer',
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
      readOnlyRepos: false,
      riskTiers: ['small', 'large'],
      repoIds: null,
    },
    skills: [],
    claimableStages: [
      { workflowKey: 'request-do-check', stageId: 'do' },
      { workflowKey: 'request-do-check', stageId: 'check' },
    ],
  },
] as never[];

const base = (): BuilderModel =>
  syncKey(
    fromDefinition(instantiateTemplate('request-do-check', { key: 'sw' }) as WorkflowDefinitionInput, {
      freeze: false,
    }),
    new Set(),
  );

function Harness(props: {
  initial?: BuilderModel;
  targets?: SubworkflowTargetsResponse;
  readOnly?: boolean;
  onModel?: (m: BuilderModel) => void;
}) {
  const [m, setM] = useState(props.initial ?? base());
  return (
    <MemoryRouter>
      <WorkflowBuilder
        model={m}
        onChange={(n) => {
          setM(n);
          props.onModel?.(n);
        }}
        roles={ROLES}
        departments={[]}
        readOnly={props.readOnly}
        subworkflowLookup={LOOKUP}
        renderSubworkflowEditor={(ctx) => (
          <SubworkflowEditor ctx={ctx} targets={props.targets ?? TARGETS} selfKey={m.key} />
        )}
      />
    </MemoryRouter>
  );
}

const step = (name: RegExp | string) => screen.getByRole('region', { name });
const editor = () => screen.getByTestId('subworkflow-editor-do');

/** The template's "Do" step turned into a sub-workflow step through the kind select. */
async function turnDoIntoSubworkflow(user = userEvent.setup()) {
  await user.selectOptions(within(step('Do')).getByLabelText('What kind of step is this?'), 'subworkflow');
  return user;
}

describe('sub-workflow step editor', () => {
  it('offers "Start another workflow" as a step kind and shows the editor with sensible defaults', async () => {
    let model!: BuilderModel;
    render(<Harness onModel={(m) => (model = m)} />);
    const kinds = within(step('Do')).getByLabelText('What kind of step is this?').querySelectorAll('option');
    expect([...kinds].map((o) => o.textContent)).toContain('Start another workflow');
    await turnDoIntoSubworkflow();
    const doStep = model.steps.find((s) => s.uid === 'do');
    expect(doStep).toMatchObject({ kind: 'subworkflow', role: null });
    expect(doStep?.subworkflow).toMatchObject({ mode: 'wait', onFailure: 'fail', project: 'same' });
    // A waiting step that fails when the other card is cancelled already has a route for that.
    expect(doStep?.routes.some((r) => r.kind === 'failure')).toBe(true);
    expect(within(editor()).getByLabelText('Workflow to start')).toBeInTheDocument();
    // The role-only controls are gone.
    expect(within(step('Do')).queryByLabelText('Who does it')).toBeNull();
    expect(within(step('Do')).queryByLabelText('If it is not good enough, send back to')).toBeNull();
  });

  it('says plainly on the step that no workflow is chosen, then clears it once one is picked', async () => {
    render(<Harness />);
    const user = await turnDoIntoSubworkflow();
    expect(within(step('Do')).getByText(/does not say which/)).toBeInTheDocument();
    const select = within(editor()).getByLabelText('Workflow to start');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('step-issues-do')).toContainElement(
      within(step('Do')).getByText(/does not say which/) as HTMLElement,
    );
    expect(select.getAttribute('aria-describedby')).toBe('step-do-issues');
    await user.selectOptions(select, 'translate');
    expect(within(step('Do')).queryByText(/does not say which/)).toBeNull();
    expect(within(editor()).getByLabelText('Workflow to start')).not.toHaveAttribute('aria-invalid');
  });

  it('does not offer the workflow being edited as its own target', async () => {
    const withSelf = targetsFor([TRANSLATE, { ...TRANSLATE, key: base().key, name: 'This one' }]);
    render(<Harness targets={withSelf} />);
    await turnDoIntoSubworkflow();
    const options = [...within(editor()).getByLabelText('Workflow to start').querySelectorAll('option')].map(
      (o) => o.textContent,
    );
    expect(options).toContain('Translate');
    expect(options).not.toContain('This one');
  });

  it('picks the target project; another project must have the workflow switched on', async () => {
    let model!: BuilderModel;
    render(<Harness onModel={(m) => (model = m)} />);
    const user = await turnDoIntoSubworkflow();
    await user.selectOptions(within(editor()).getByLabelText('Workflow to start'), 'translate');
    const project = within(editor()).getByLabelText('Where the new card goes');
    const web = within(project).getByRole('option', { name: /Web \(WEB\)/ }) as HTMLOptionElement;
    const sup = within(project).getByRole('option', {
      name: /Support \(SUP\).*not switched on/,
    }) as HTMLOptionElement;
    expect(web.disabled).toBe(false);
    expect(sup.disabled).toBe(true);
    await user.selectOptions(project, WEB);
    expect(model.steps.find((s) => s.uid === 'do')?.subworkflow?.project).toEqual({ projectId: WEB });
    await user.selectOptions(project, 'same');
    expect(model.steps.find((s) => s.uid === 'do')?.subworkflow?.project).toBe('same');
  });

  it('card type and start, with the hint saying what automatic means', async () => {
    let model!: BuilderModel;
    render(<Harness onModel={(m) => (model = m)} />);
    const user = await turnDoIntoSubworkflow();
    const start = () => within(editor()).getByLabelText('Start the new card');
    expect(start().closest('div')).toHaveTextContent(/Choose the workflow first/);
    await user.selectOptions(within(editor()).getByLabelText('Workflow to start'), 'translate');
    // The customer is needed and not passed on: automatic means a draft.
    expect(start().closest('div')).toHaveTextContent(/starts as a draft because it still needs: Customer/);
    await user.selectOptions(within(editor()).getByLabelText('Kind of card to create'), 'support');
    expect(model.steps.find((s) => s.uid === 'do')?.subworkflow?.cardType).toBe('support');
    await user.selectOptions(start(), 'queued');
    expect(model.steps.find((s) => s.uid === 'do')?.subworkflow?.start).toBe('queued');
    // Queued with a required field left empty is a tip on the step.
    expect(within(step('Do')).getByText(/leaves required information empty/)).toBeInTheDocument();
    await user.selectOptions(start(), '');
    expect(model.steps.find((s) => s.uid === 'do')?.subworkflow).not.toHaveProperty('start');
  });

  it('maps information in from a field, a fixed value or a template, and out in wait mode', async () => {
    let model!: BuilderModel;
    render(<Harness onModel={(m) => (model = m)} />);
    const user = await turnDoIntoSubworkflow();
    await user.selectOptions(within(editor()).getByLabelText('Workflow to start'), 'translate');
    const add = () => user.click(within(editor()).getByRole('button', { name: /Pass on information/ }));
    const cfg = () => configOf(model.steps.find((s) => s.uid === 'do') as never);

    // 1: the customer (needed ones come first) from a field of this card.
    await add();
    expect(cfg().fieldsIn).toEqual([{ to: 'customer', from: { value: '' } }]);
    await user.selectOptions(within(editor()).getByLabelText('Information 1: comes from'), 'field');
    await user.selectOptions(within(editor()).getByLabelText('Information 1: which field'), 'request');
    expect(cfg().fieldsIn[0]).toEqual({ to: 'customer', from: { field: 'request' } });

    // 2: a yes/no field takes a fixed yes or no.
    await add();
    await user.selectOptions(
      within(editor()).getByLabelText('Information 2: field of the new card'),
      'urgent',
    );
    await user.selectOptions(within(editor()).getByLabelText('Information 2: value'), 'yes');
    expect(cfg().fieldsIn[1]).toEqual({ to: 'urgent', from: { value: true } });

    // 3: text with tokens.
    await add();
    await user.selectOptions(
      within(editor()).getByLabelText('Information 3: field of the new card'),
      'reply',
    );
    await user.selectOptions(within(editor()).getByLabelText('Information 3: comes from'), 'template');
    fireEvent.change(within(editor()).getByLabelText('Information 3: text'), {
      target: { value: '{card.ref}: {card.title}' },
    });
    expect(cfg().fieldsIn[2]).toEqual({ to: 'reply', from: { template: '{card.ref}: {card.title}' } });

    // 4: a list takes comma separated items.
    await add();
    await user.selectOptions(
      within(editor()).getByLabelText('Information 4: field of the new card'),
      'glossary',
    );
    fireEvent.change(within(editor()).getByLabelText('Information 4: value'), {
      target: { value: 'a, b ,, c' },
    });
    expect(cfg().fieldsIn[3]).toEqual({ to: 'glossary', from: { value: ['a', 'b', 'c'] } });

    // A field of the new card is passed once only.
    const used = within(editor()).getByLabelText('Information 2: field of the new card');
    expect((within(used).getByRole('option', { name: /^Customer/ }) as HTMLOptionElement).disabled).toBe(
      true,
    );

    // Out: only while waiting.
    await user.click(within(editor()).getByRole('button', { name: /Bring back information/ }));
    expect(cfg().fieldsOut).toEqual([{ from: 'customer', to: 'request' }]);
    await user.selectOptions(within(editor()).getByLabelText('Result 1: field of the new card'), 'reply');
    expect(cfg().fieldsOut).toEqual([{ from: 'reply', to: 'request' }]);

    await user.click(within(editor()).getByRole('button', { name: /Remove information 2/ }));
    expect(cfg().fieldsIn.map((r) => r.to)).toEqual(['customer', 'reply', 'glossary']);
  });

  it('switching to "carries on" hides and clears what is brought back, and the cancelled route', async () => {
    let model!: BuilderModel;
    render(<Harness onModel={(m) => (model = m)} />);
    const user = await turnDoIntoSubworkflow();
    await user.selectOptions(within(editor()).getByLabelText('Workflow to start'), 'translate');
    await user.click(within(editor()).getByRole('button', { name: /Bring back information/ }));
    expect(within(editor()).getByTestId('field-out-do')).toBeInTheDocument();
    expect(within(editor()).getByLabelText('If the new card is cancelled')).toBeInTheDocument();

    await user.click(within(editor()).getByLabelText('Carries on at once'));
    expect(within(editor()).queryByTestId('field-out-do')).toBeNull();
    expect(within(editor()).queryByLabelText('If the new card is cancelled')).toBeNull();
    const doStep = model.steps.find((s) => s.uid === 'do');
    expect(doStep?.subworkflow).toMatchObject({ mode: 'continue', fieldsOut: [] });
    expect(doStep?.routes.some((r) => r.kind === 'failure')).toBe(false);
    expect(toDefinition(model).stages.find((s) => s.id === 'do')?.subworkflow?.fieldsOut).toEqual([]);

    // Back to waiting: the route for a cancelled card comes back, pointing at the step before.
    await user.click(within(editor()).getByLabelText('Waits for it'));
    const back = model.steps.find((s) => s.uid === 'do')?.routes.find((r) => r.kind === 'failure');
    expect(back?.to).toBe('request');
  });

  it('on failure: fail asks where to go, continue needs no route', async () => {
    let model!: BuilderModel;
    render(<Harness onModel={(m) => (model = m)} />);
    const user = await turnDoIntoSubworkflow();
    await user.selectOptions(within(editor()).getByLabelText('Workflow to start'), 'translate');
    const goTo = within(editor()).getByLabelText('When it fails, go to');
    await user.selectOptions(goTo, 'finished');
    expect(model.steps.find((s) => s.uid === 'do')?.routes.find((r) => r.kind === 'failure')?.to).toBe(
      'finished',
    );
    await user.selectOptions(within(editor()).getByLabelText('If the new card is cancelled'), 'continue');
    expect(within(editor()).queryByLabelText('When it fails, go to')).toBeNull();
    expect(model.steps.find((s) => s.uid === 'do')?.routes.some((r) => r.kind === 'failure')).toBe(false);
    expect(model.steps.find((s) => s.uid === 'do')?.subworkflow?.onFailure).toBe('continue');
  });

  it('a waiting step with no route for a cancelled card shows the plain problem, pointing at the route select', async () => {
    const m = base();
    const model = {
      ...m,
      steps: m.steps.map((s) =>
        s.uid === 'do'
          ? {
              ...s,
              kind: 'subworkflow' as const,
              role: null,
              subworkflow: { workflowKey: 'translate', mode: 'wait' as const, onFailure: 'fail' as const },
            }
          : s,
      ),
    };
    render(<Harness initial={model} />);
    expect(within(step('Do')).getByText(/no route for when that work is cancelled/)).toBeInTheDocument();
    const goTo = within(editor()).getByLabelText('When it fails, go to');
    expect(goTo).toHaveAttribute('aria-invalid', 'true');
    await userEvent.setup().selectOptions(goTo, 'finished');
    expect(within(step('Do')).queryByText(/no route for when that work is cancelled/)).toBeNull();
  });

  it('Try a card shows the sub-workflow step', async () => {
    render(<Harness />);
    const user = await turnDoIntoSubworkflow();
    await user.selectOptions(within(editor()).getByLabelText('Workflow to start'), 'translate');
    const note = await screen.findByTestId('try-subworkflow-1');
    expect(note).toHaveTextContent('Starts Translate and waits for it');
    await user.click(within(editor()).getByLabelText('Carries on at once'));
    expect(screen.getByTestId('try-subworkflow-1')).toHaveTextContent(
      'Starts Translate and carries on at once',
    );
  });

  it('read-only: nothing can be changed', async () => {
    const m = base();
    const model = {
      ...m,
      steps: m.steps.map((s) =>
        s.uid === 'do'
          ? { ...s, kind: 'subworkflow' as const, role: null, subworkflow: { workflowKey: 'translate' } }
          : s,
      ),
    };
    render(<Harness initial={model} readOnly />);
    expect(within(editor()).getByLabelText('Workflow to start')).toBeDisabled();
    expect(within(editor()).queryByRole('button', { name: /Pass on information/ })).toBeNull();
  });
});

describe('sub-workflow step in the builder model', () => {
  const withStep = (): { model: BuilderModel; fieldUid: string } => {
    let model = base();
    const added = addField(model, 'Customer name');
    model = updateField(added.model, added.uid, { type: 'text' });
    model = {
      ...model,
      steps: model.steps.map((s) =>
        s.uid === 'do'
          ? {
              ...s,
              kind: 'subworkflow' as const,
              role: null,
              subworkflow: {
                workflowKey: 'translate',
                project: { projectId: WEB },
                cardType: 'support',
                mode: 'wait' as const,
                start: 'queued' as const,
                fieldsIn: [
                  { to: 'customer', from: { field: added.uid } },
                  { to: 'urgent', from: { value: true } },
                  { to: 'reply', from: { template: '{card.title}' } },
                ],
                fieldsOut: [{ from: 'reply', to: added.uid }],
                onFailure: 'continue' as const,
              },
            }
          : s,
      ),
    };
    return { model, fieldUid: added.uid };
  };

  it('toDefinition writes field keys, fromDefinition reads them back, and the settings survive both ways', () => {
    const { model } = withStep();
    const def = toDefinition(model);
    const stage = def.stages.find((s) => s.id === 'do');
    expect(stage?.kind).toBe('subworkflow');
    expect(stage?.subworkflow).toEqual({
      workflowKey: 'translate',
      project: { projectId: WEB },
      cardType: 'support',
      mode: 'wait',
      start: 'queued',
      fieldsIn: [
        { to: 'customer', from: { field: 'customer_name' } },
        { to: 'urgent', from: { value: true } },
        { to: 'reply', from: { template: '{card.title}' } },
      ],
      fieldsOut: [{ from: 'reply', to: 'customer_name' }],
      onFailure: 'continue',
    });
    const again = fromDefinition(def);
    expect(toDefinition(again)).toEqual(def);
    const s = again.steps.find((x) => x.uid === 'do');
    expect(s?.subworkflow?.fieldsIn?.[0]).toEqual({ to: 'customer', from: { field: 'customer_name' } });
    expect(s?.kind).toBe('subworkflow');
  });

  it('a mapping follows its field when the field is renamed, and goes when the field is removed', () => {
    const { model, fieldUid } = withStep();
    const renamed = updateField(model, fieldUid, { label: 'Client', key: undefined });
    // Not yet saved: the key follows the label, the mapping follows the key.
    const def = toDefinition(renamed);
    expect(def.stages.find((s) => s.id === 'do')?.subworkflow?.fieldsIn?.[0]?.from).toEqual({
      field: 'client',
    });
    const without = removeField(model, fieldUid);
    const sub = without.steps.find((s) => s.uid === 'do')?.subworkflow;
    expect(sub?.fieldsIn?.map((r) => r.to)).toEqual(['urgent', 'reply']);
    expect(sub?.fieldsOut).toEqual([]);
  });

  it('validation: missing workflow, unknown field, a continue step cannot bring back, unknown project and loops', () => {
    const ctx = { roles: ROLES, departments: [], subworkflowLookup: LOOKUP };
    const { model } = withStep();
    const codes = (m: BuilderModel) => validateBuilder(m, ctx).issues.map((i) => i.code);
    const patch = (over: object): BuilderModel => ({
      ...model,
      steps: model.steps.map((s) =>
        s.uid === 'do' ? { ...s, subworkflow: { ...(s.subworkflow as object), ...over } as never } : s,
      ),
    });
    // A step with the workflow left blank is "does not say which", never a raw schema message.
    const blank = codes(patch({ workflowKey: '' }));
    expect(blank).toContain('subworkflow_missing_config');
    expect(blank).not.toContain('invalid_schema');
    expect(codes(patch({ workflowKey: 'ghost' }))).toContain('subworkflow_unknown_target');
    expect(codes(patch({ fieldsIn: [{ to: 'nope', from: { value: 'x' } }] }))).toContain(
      'subworkflow_unknown_field',
    );
    expect(codes(patch({ mode: 'continue' }))).toContain('subworkflow_field_out_in_continue');
    expect(codes(patch({ project: { projectId: SUP } }))).toContain('subworkflow_target_not_enabled');
    expect(codes(patch({ cardType: 'bug' }))).toContain('subworkflow_unknown_card_type');
    // A workflow cannot start itself.
    expect(codes(patch({ workflowKey: model.key }))).toContain('subworkflow_cycle');
    // Without a lookup the target is not judged here (the server does when saving).
    expect(
      validateBuilder(patch({ workflowKey: 'ghost' }), { roles: ROLES, departments: [] }).issues.map(
        (i) => i.code,
      ),
    ).not.toContain('subworkflow_unknown_target');
  });
});
