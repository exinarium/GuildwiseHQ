import {
  type DefinitionIssue,
  type FrozenIds,
  type RoleDefinition,
  type SimulationResult,
  simulatePath,
  WorkflowDefinitionSchema,
} from '@aom/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  appendStep,
  type BuilderModel,
  type BuilderValidation,
  CARD_TYPE_LABEL,
  fieldKeys,
  insertStepAfter,
  moveStep,
  removeStep,
  stepIds,
  syncKey,
  validateBuilder,
  yesNoFields,
} from '../../lib/builder.ts';
import { WorkflowGraph } from '../org/WorkflowGraph.tsx';
import { Button, Select, TextInput } from '../ui.tsx';
import { AutoStartSection } from './AutoStartSection.tsx';
import { FieldList } from './FieldList.tsx';
import { IssueBar } from './IssueBar.tsx';
import { StepCard, type SubworkflowSlotContext } from './StepCard.tsx';
import { TryACard } from './TryACard.tsx';
import { VariantBuilder, type VariantBuilderProps } from './VariantBuilder.tsx';

const CARD_TYPES = ['feature', 'bug', 'support', 'refactor', 'docs'];

export interface WorkflowBuilderProps {
  /** Every step editable (a custom workflow of the organization). The default scope. */
  scope?: 'org';
  model: BuilderModel;
  onChange: (m: BuilderModel) => void;
  roles: readonly RoleDefinition[];
  departments: readonly string[];
  /** Keys that a new workflow must not take (the key follows the name until the first save). */
  takenKeys?: ReadonlySet<string>;
  /** Roles with at least one hired agent; undefined: unknown, no warning. */
  hiredRoleKeys?: ReadonlySet<string>;
  /** Ids of the approved version: renaming a step never changes them. */
  frozen?: FrozenIds;
  /** The server's issues from the last save; they replace the local ones until the next edit. */
  serverIssues?: readonly DefinitionIssue[];
  readOnly?: boolean;
  showWorktree?: boolean;
  /** Extension point for the sub-workflow step editor (docs/design/workflow-builder.md D7, built with the server side). */
  renderSubworkflowEditor?: (ctx: SubworkflowSlotContext) => React.ReactNode;
  /** Reports the validation after every change (the page enables Submit from it). */
  onValidation?: (v: BuilderValidation) => void;
  /** Extra content under "Try a card" (the page puts the BA chat there). */
  aside?: React.ReactNode;
  /** Show "Starts automatically when ..." (the automations of this workflow). The workflow page turns it on. */
  autoStart?: boolean;
}

/**
 * The guided workflow builder in its two scopes (docs/design/workflow-builder.md D2): `org` edits a whole custom
 * workflow; `project-variant` locks the base workflow's steps and edits the insertions of a project's variant.
 */
export function WorkflowBuilder(p: VariantBuilderProps): React.JSX.Element;
export function WorkflowBuilder(p: WorkflowBuilderProps): React.JSX.Element;
export function WorkflowBuilder(p: WorkflowBuilderProps | VariantBuilderProps): React.JSX.Element {
  return p.scope === 'project-variant' ? <VariantBuilder {...p} /> : <OrgWorkflowBuilder {...p} />;
}

/**
 * The guided workflow builder: the step list on the left, the live diagram, "Try a card" and the issues on the right.
 * It edits a `BuilderModel`; the page turns that into a draft with `toDefinition`.
 */
function OrgWorkflowBuilder(p: WorkflowBuilderProps) {
  const { model, readOnly = false } = p;
  const takenKeys = p.takenKeys ?? new Set<string>();
  const change = (m: BuilderModel) => p.onChange(syncKey(m, takenKeys));
  const validation = useMemo(
    () =>
      validateBuilder(
        model,
        { roles: p.roles, departments: p.departments, frozen: p.frozen },
        p.serverIssues,
      ),
    [model, p.roles, p.departments, p.frozen, p.serverIssues],
  );
  const { onValidation } = p;
  useEffect(() => onValidation?.(validation), [validation, onValidation]);

  const ids = useMemo(() => stepIds(model, p.frozen), [model, p.frozen]);
  const uidOf = useMemo(() => new Map([...ids].map(([uid, id]) => [id, uid])), [ids]);

  // Which step details are open: all of them in a short workflow, otherwise the ones with problems.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => {
    if (model.steps.length <= 5) return new Set(model.steps.map((s) => s.uid));
    const bad = new Set<string>();
    for (const id of validation.byStage.keys()) {
      const uid = uidOf.get(id);
      if (uid) bad.add(uid);
    }
    return bad;
  });
  const toggle = (uid: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });

  // Move focus to a step name (after "Add a step") or a step heading (after "go to" in the issue bar).
  const [focus, setFocus] = useState<{ id: string; scroll?: boolean } | null>(null);
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(focus.id);
    if (el) {
      el.focus();
      if (focus.scroll !== false) el.scrollIntoView?.({ block: 'center' });
    }
    setFocus(null);
  }, [focus]);

  const jump = (stageId: string | null) => {
    if (stageId === null) {
      setFocus({ id: 'builder-name' });
      return;
    }
    const uid = uidOf.get(stageId);
    if (!uid) return;
    setOpen((o) => new Set(o).add(uid));
    setFocus({ id: `step-${uid}-title` });
  };

  const added = (uid: string) => {
    setOpen((o) => new Set(o).add(uid));
    setFocus({ id: `step-${uid}-label` });
  };

  // "Try a card".
  const [values, setValues] = useState<Record<string, boolean>>({});
  const [choices, setChoices] = useState<(string | undefined)[]>([]);
  const parsed = useMemo(
    () => WorkflowDefinitionSchema.safeParse({ ...validation.def, version: 1, builtIn: false }),
    [validation.def],
  );
  const sim: SimulationResult | null = useMemo(
    () => (parsed.success ? simulatePath(parsed.data, { fields: values }, choices) : null),
    [parsed, values, choices],
  );
  const tryFields = useMemo(() => {
    const keys = fieldKeys(model, p.frozen);
    return yesNoFields(model).map((f) => ({ key: keys.get(f.uid) ?? f.uid, label: f.label }));
  }, [model, p.frozen]);
  const roleName = (key: string) => p.roles.find((r) => r.key === key)?.name ?? key;
  const flagged = useMemo(() => {
    const out = new Set<string>();
    for (const [id, list] of validation.byStage)
      if (id && list.some((i) => i.severity === 'error')) out.add(id);
    return out;
  }, [validation.byStage]);
  const lastIsTerminal = model.steps[model.steps.length - 1]?.kind === 'terminal';

  return (
    <div className="flex flex-col gap-4" data-testid="workflow-builder">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput
          id="builder-name"
          label="Workflow name"
          value={model.name}
          disabled={readOnly}
          hint={`Internal key: ${model.key || '(from the name)'}`}
          onChange={(e) => change({ ...model, name: e.target.value })}
        />
        <Select
          label="Department"
          value={model.department ?? ''}
          disabled={readOnly}
          onChange={(e) => change({ ...model, department: e.target.value || undefined })}
        >
          <option value="">None</option>
          {p.departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
      </div>
      <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" disabled={readOnly}>
        <legend className="mb-1 text-sm font-medium">What kinds of card use it</legend>
        {CARD_TYPES.map((t) => (
          <label key={t} className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={model.cardTypes.includes(t)}
              onChange={(e) =>
                change({
                  ...model,
                  cardTypes: e.target.checked
                    ? [...model.cardTypes, t]
                    : model.cardTypes.filter((x) => x !== t),
                })
              }
            />
            {CARD_TYPE_LABEL[t] ?? t}
          </label>
        ))}
      </fieldset>

      <IssueBar
        issues={validation.issues}
        labelOf={(id) => model.steps.find((s) => s.uid === uidOf.get(id))?.label || undefined}
        onJump={jump}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <section aria-labelledby="builder-steps-title" className="flex flex-col gap-3">
            <div>
              <h2 id="builder-steps-title" className="text-base font-semibold">
                Steps
              </h2>
              <p className="text-xs text-subtle">
                A card goes through these in order. Use "Move up" and "Move down" to change the order.
              </p>
            </div>
            <ol className="flex flex-col gap-3" data-testid="step-list">
              {model.steps.map((s, i) => (
                <StepCard
                  key={s.uid}
                  index={i}
                  step={s}
                  model={model}
                  onChange={change}
                  issues={validation.byStage.get(ids.get(s.uid) ?? '') ?? []}
                  roles={p.roles}
                  hiredRoleKeys={p.hiredRoleKeys}
                  stageId={ids.get(s.uid) ?? s.uid}
                  frozen={p.frozen}
                  open={open.has(s.uid)}
                  onToggle={() => toggle(s.uid)}
                  readOnly={readOnly}
                  showWorktree={p.showWorktree}
                  renderSubworkflowEditor={p.renderSubworkflowEditor}
                  onInsertAfter={() => {
                    const r = insertStepAfter(model, i);
                    change(r.model);
                    added(r.uid);
                  }}
                  onMove={(dir) => change(moveStep(model, s.uid, dir))}
                  onRemove={() => change(removeStep(model, s.uid))}
                  canRemove={model.steps.length > 2}
                />
              ))}
            </ol>
            {!readOnly && (
              <div>
                <Button
                  onClick={() => {
                    const r = appendStep(model);
                    change(r.model);
                    added(r.uid);
                  }}
                >
                  Add a step{lastIsTerminal ? ' before the end' : ''}
                </Button>
              </div>
            )}
          </section>
          <FieldList
            model={model}
            onChange={change}
            readOnly={readOnly}
            onAdded={(uid) => setFocus({ id: `field-${uid}-label` })}
          />
          {p.autoStart && model.key && <AutoStartSection workflowKey={model.key} readOnly={readOnly} />}
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
          <section aria-labelledby="diagram-title" className="flex flex-col gap-1">
            <h2 id="diagram-title" className="text-base font-semibold">
              Diagram
            </h2>
            <p className="sr-only">The same flow as the list of steps, drawn as boxes and arrows.</p>
            {parsed.success ? (
              <WorkflowGraph def={parsed.data} flagged={flagged} path={sim?.path ?? []} />
            ) : (
              <p className="text-sm text-subtle">The diagram appears once the steps are filled in.</p>
            )}
            <p className="text-xs text-subtle">Red dashed arrows send a card back for another round.</p>
          </section>
          <TryACard
            sim={validation.errors === 0 || parsed.success ? sim : null}
            yesNoFields={tryFields}
            values={values}
            onValue={(k, v) => setValues((x) => ({ ...x, [k]: v }))}
            onChoice={(visit, routeId) =>
              setChoices((c) => {
                const n = [...c];
                while (n.length < visit) n.push(undefined);
                n[visit] = routeId;
                return n.slice(0, visit + 1);
              })
            }
            roleName={roleName}
            hiredRoleKeys={p.hiredRoleKeys}
          />
          {p.aside}
        </div>
      </div>
    </div>
  );
}
