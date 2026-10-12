import {
  type DefinitionIssue,
  describeDiff,
  diffDefinitions,
  type RoleDefinition,
  type SimulationResult,
  simulatePath,
  type WorkflowDefinition,
} from '@aom/shared';
import { AlertCircle, AlertTriangle, ArrowDown, ArrowUp, Lock, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  canMoveInserted,
  checkVariant,
  type EditorInsertion,
  moveInsertion,
  removeInsertion,
  updateInsertion,
  type VariantCheck,
  variantRows,
} from '../../lib/workflowVariant.ts';
import { WorkflowGraph } from '../org/WorkflowGraph.tsx';
import { Badge, Button, Select, TextArea, TextInput } from '../ui.tsx';
import { InsertStepForm } from './InsertStepForm.tsx';
import { IssueBar } from './IssueBar.tsx';
import { TryACard } from './TryACard.tsx';

/** The most steps a variant may insert (the server's limit). */
export const MAX_INSERTIONS = 8;

export interface VariantBuilderProps {
  scope: 'project-variant';
  /** The exact base version the variant is authored on: its steps are shown locked. */
  base: WorkflowDefinition;
  variantKey: string;
  variantName: string;
  projectId: string;
  /** The author's edits; the storage format of a variant. */
  insertions: readonly EditorInsertion[];
  onChange: (next: EditorInsertion[]) => void;
  roles: readonly RoleDefinition[];
  /** Roles with at least one hired agent; undefined: unknown, no warning. */
  hiredRoleKeys?: ReadonlySet<string>;
  /** The server's issues from the last save; they replace the local ones until the next edit. */
  serverIssues?: readonly DefinitionIssue[];
  /** A version waits for approval: nothing can be changed. */
  readOnly?: boolean;
  /** What "Compare with previous" shows the draft against (the approved variant, else the base). */
  compareWith?: { label: string; def: WorkflowDefinition } | null;
  onValidation?: (v: VariantCheck) => void;
  /** Content above the step list (key and name inputs). */
  header?: React.ReactNode;
  aside?: React.ReactNode;
}

/**
 * The workflow builder in "project variant" scope (docs/design/workflow-builder.md D2): the base workflow's steps are
 * locked, the author inserts steps after them. The builder state is the insertion list; the definition, the diagram,
 * the issues and "Try a card" are derived from it with the shared `materialiseVariant` / `validateVariant`.
 */
export function VariantBuilder(p: VariantBuilderProps) {
  const { base, insertions, readOnly = false } = p;
  const spec = useMemo(
    () => ({ key: p.variantKey, name: p.variantName, projectId: p.projectId, insertions }),
    [p.variantKey, p.variantName, p.projectId, insertions],
  );
  const check = useMemo(
    () => checkVariant(base, spec, p.roles, p.serverIssues),
    [base, spec, p.roles, p.serverIssues],
  );
  const { onValidation } = p;
  useEffect(() => onValidation?.(check), [check, onValidation]);

  const rows = useMemo(() => variantRows(base, check.def, insertions), [base, check.def, insertions]);
  const def = check.def ?? base;
  const [adding, setAdding] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(focus);
    if (el) {
      el.focus();
      el.scrollIntoView?.({ block: 'center' });
    }
    setFocus(null);
  }, [focus]);

  const labelOf = (id: string) => rows.find((r) => r.id === id)?.label;
  const roleName = (key: string) => p.roles.find((r) => r.key === key)?.name ?? key;
  const flagged = useMemo(() => {
    const out = new Set<string>();
    for (const [id, list] of check.byStage) if (id && list.some((i) => i.severity === 'error')) out.add(id);
    return out;
  }, [check.byStage]);

  // "Try a card".
  const [values, setValues] = useState<Record<string, boolean>>({});
  const [choices, setChoices] = useState<(string | undefined)[]>([]);
  const sim: SimulationResult | null = useMemo(
    () => (check.def ? simulatePath(check.def, { fields: values }, choices) : null),
    [check.def, values, choices],
  );
  const tryFields = def.customFields.filter((f) => f.type === 'boolean');

  const full = insertions.length >= MAX_INSERTIONS;
  const taken = rows.map((r) => r.id);

  return (
    <div className="flex flex-col gap-4" data-testid="workflow-builder" data-scope="project-variant">
      {p.header}
      <IssueBar
        issues={check.issues}
        labelOf={labelOf}
        onJump={(id) => id && setFocus(`vstep-${id}-title`)}
      />

      <section aria-labelledby="variant-steps-title" className="flex flex-col gap-3">
        <div>
          <h2 id="variant-steps-title" className="text-base font-semibold">
            Steps
          </h2>
          <p className="text-xs text-subtle">
            The steps of {base.name} are locked. Add your own steps after them; you can move or remove the
            steps you add.
          </p>
        </div>
        <ol className="flex flex-col" data-testid="variant-stages" aria-label="Steps">
          {rows.map((r, i) => {
            const issues = check.byStage.get(r.id) ?? [];
            const errors = issues.filter((x) => x.severity === 'error').length;
            const titleId = `vstep-${r.id}-title`;
            const ins = insertions.find((x) => x.stage.id === r.id);
            const change = (patch: Parameters<typeof updateInsertion>[2]) =>
              p.onChange(updateInsertion(insertions, r.id, patch));
            const isTemplate = r.id.startsWith('investigate');
            return (
              <li key={r.id} className="flex flex-col">
                <section
                  aria-labelledby={titleId}
                  data-testid={r.inserted ? 'inserted-stage' : 'base-stage'}
                  data-invalid={errors > 0 ? 'true' : undefined}
                  className={`flex flex-col gap-2 rounded-card border p-3 ${
                    errors > 0
                      ? 'border-danger'
                      : r.inserted
                        ? 'border-brand bg-brand-soft'
                        : 'border-line bg-surface'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">Step {i + 1}</Badge>
                    <h3
                      id={titleId}
                      tabIndex={-1}
                      className="min-w-0 flex-1 truncate text-base font-semibold"
                    >
                      {r.label || 'Untitled step'}
                    </h3>
                    {r.claimRole && <Badge>{roleName(r.claimRole)}</Badge>}
                    {r.kind === 'terminal' && <Badge tone="green">Finished</Badge>}
                    {r.inserted ? (
                      <Badge tone="brand">new step</Badge>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-subtle">
                        <Lock aria-hidden="true" className="size-3" />
                        from {base.key}, cannot be changed
                      </span>
                    )}
                    {errors > 0 && (
                      <Badge tone="red" icon={<AlertCircle aria-hidden="true" className="size-3" />}>
                        {errors === 1 ? '1 problem' : `${errors} problems`}
                      </Badge>
                    )}
                  </div>
                  {issues.length > 0 && (
                    <ul className="flex flex-col gap-1 text-sm" data-testid={`step-issues-${r.id}`}>
                      {issues.map((x, n) => (
                        <li
                          // biome-ignore lint/suspicious/noArrayIndexKey: the same sentence can appear twice
                          key={`${x.code}-${n}`}
                          data-testid="step-issue"
                          className="flex items-start gap-1.5"
                        >
                          {x.severity === 'error' ? (
                            <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
                          ) : (
                            <AlertTriangle
                              aria-hidden="true"
                              className="mt-0.5 size-4 shrink-0 text-warning"
                            />
                          )}
                          <span className={x.severity === 'error' ? 'text-danger' : 'text-warning'}>
                            <span className="sr-only">{x.severity === 'error' ? 'Problem: ' : 'Tip: '}</span>
                            {x.text}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {ins && !readOnly && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <TextInput
                        id={`vstep-${r.id}-label`}
                        label="Step name"
                        value={ins.stage.label}
                        onChange={(e) => change({ label: e.target.value })}
                      />
                      <Select
                        label="Who works it"
                        value={ins.stage.claimRole}
                        disabled={isTemplate}
                        onChange={(e) => change({ claimRole: e.target.value })}
                      >
                        {!p.roles.some((x) => x.key === ins.stage.claimRole) && (
                          <option value={ins.stage.claimRole}>{ins.stage.claimRole}</option>
                        )}
                        {p.roles.map((x) => (
                          <option key={x.key} value={x.key}>
                            {x.name}
                          </option>
                        ))}
                      </Select>
                      <div className="sm:col-span-2">
                        <TextArea
                          label="Done when"
                          value={ins.stage.doneCriteria ?? ''}
                          onChange={(e) => change({ doneCriteria: e.target.value })}
                        />
                      </div>
                    </div>
                  )}
                  {ins && readOnly && r.doneCriteria && (
                    <p className="text-sm text-muted">{r.doneCriteria}</p>
                  )}
                  {ins && r.claimRole && p.hiredRoleKeys && !p.hiredRoleKeys.has(r.claimRole) && (
                    <p className="text-xs text-warning">No agent of this role is hired yet.</p>
                  )}
                  {ins && !readOnly && (
                    <div
                      className="flex flex-wrap gap-1.5"
                      role="group"
                      aria-label={`Actions for ${r.label}`}
                    >
                      <Button
                        size="sm"
                        aria-label={`Move ${r.label} up`}
                        disabled={!canMoveInserted(rows, i, -1)}
                        onClick={() => p.onChange(moveInsertion(insertions, rows, r.id, -1))}
                      >
                        <ArrowUp aria-hidden="true" className="size-4" />
                        Move up
                      </Button>
                      <Button
                        size="sm"
                        aria-label={`Move ${r.label} down`}
                        disabled={!canMoveInserted(rows, i, 1)}
                        onClick={() => p.onChange(moveInsertion(insertions, rows, r.id, 1))}
                      >
                        <ArrowDown aria-hidden="true" className="size-4" />
                        Move down
                      </Button>
                      <Button
                        size="sm"
                        variant="danger-ghost"
                        className="ml-auto"
                        aria-label={`Remove step ${r.label}`}
                        onClick={() => p.onChange(removeInsertion(insertions, r.id))}
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                        Remove
                      </Button>
                    </div>
                  )}
                </section>
                {r.kind !== 'terminal' && !readOnly && (
                  <div className="flex flex-col py-1 pl-4">
                    {adding === r.id ? (
                      <InsertStepForm
                        after={r}
                        variantKey={p.variantKey}
                        roles={p.roles}
                        taken={taken}
                        onCancel={() => setAdding(null)}
                        onAdd={(next) => {
                          setAdding(null);
                          p.onChange([...insertions, next]);
                          setFocus(`vstep-${next.stage.id}-label`);
                        }}
                      />
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="self-start"
                        aria-label={`Insert step after ${r.label}`}
                        disabled={full}
                        title={full ? `A variant can add at most ${MAX_INSERTIONS} steps` : undefined}
                        onClick={() => setAdding(r.id)}
                      >
                        <Plus aria-hidden="true" className="size-4" />
                        Insert step after {r.label}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-labelledby="diagram-title" className="flex flex-col gap-1">
        <h2 id="diagram-title" className="text-base font-semibold">
          Diagram
        </h2>
        <p className="sr-only">The same flow as the list of steps, drawn as boxes and arrows.</p>
        {check.def ? (
          <WorkflowGraph def={check.def} flagged={flagged} path={sim?.path ?? []} />
        ) : (
          <p className="text-sm text-subtle">The diagram appears once the new steps can be placed.</p>
        )}
      </section>

      <TryACard
        sim={sim}
        yesNoFields={tryFields.map((f) => ({ key: f.key, label: f.label }))}
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

      {p.compareWith && check.def && <VariantCompare with={p.compareWith} def={check.def} />}
      {p.aside}
    </div>
  );
}

/** "Compare with previous": what this draft changes against the approved variant (or the base, for a first draft). */
function VariantCompare({
  with: other,
  def,
}: {
  with: { label: string; def: WorkflowDefinition };
  def: WorkflowDefinition;
}) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(
    () => (open ? describeDiff(diffDefinitions(other.def, def)) : []),
    [open, other.def, def],
  );
  return (
    <section
      aria-labelledby="variant-compare-title"
      className="flex flex-col gap-2"
      data-testid="variant-compare"
    >
      <h2 id="variant-compare-title" className="text-base font-semibold">
        Changes
      </h2>
      <div>
        <Button size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          Compare with previous
        </Button>
        <span className="ml-2 text-xs text-subtle">against {other.label}</span>
      </div>
      {open &&
        (lines.length === 0 ? (
          <p className="text-xs text-subtle">No difference.</p>
        ) : (
          <ul className="list-disc pl-5 text-sm" data-testid="diff-lines">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ))}
    </section>
  );
}
