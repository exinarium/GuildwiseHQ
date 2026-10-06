import {
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  type DefinitionIssue,
  type RoleDefinition,
  type Stage,
  validateCustomWorkflow,
  WorkflowDefinitionSchema,
  type WorkflowDraftInput,
} from '@aom/shared';
import { useMemo, useState } from 'react';
import { errorCount, groupIssues, stageId } from '../../lib/designer.ts';
import { Badge, Button, Select, TextInput } from '../ui.tsx';
import { ListInput } from './ListInput.tsx';
import { WorkflowGraph } from './WorkflowGraph.tsx';

type Outcome = Stage['outcomes'][number];

const blankStage = (n: number): Stage => ({
  id: `stage_${n}`,
  label: `Stage ${n}`,
  column: `Stage ${n}`,
  kind: 'agent',
  claimRole: null,
  seniorOnly: false,
  requiredFields: [],
  doneCriteria: '',
  outcomes: [],
  worktree: 'none',
  rebaseBefore: false,
  maxShiftMinutes: 60,
  requiredCapabilities: [],
});

const blankOutcome = (to: string, n: number): Outcome => ({
  id: `outcome_${n}`,
  label: `Outcome ${n}`,
  kind: 'success',
  to,
  event: 'StageCompleted',
  data: 'none',
  rework: false,
  effect: 'none',
});

const CARD_TYPES = ['feature', 'bug', 'support', 'refactor', 'docs'];

/**
 * The workflow editor: metadata, a stage table with outcomes (claiming role, required fields, done criteria, failure
 * routes), a graph preview and the validation issues inline. The same shared validator the server runs gives the
 * issues while typing; saving shows the server's.
 */
export function WorkflowEditor({
  value,
  onChange,
  roles,
  departments,
  serverIssues,
  readOnly = false,
}: {
  value: WorkflowDraftInput;
  onChange: (v: WorkflowDraftInput) => void;
  roles: readonly RoleDefinition[];
  departments: readonly string[];
  serverIssues?: readonly DefinitionIssue[];
  readOnly?: boolean;
}) {
  const [stageCount, setStageCount] = useState(value.stages.length);
  const issues: DefinitionIssue[] = useMemo(() => {
    const def = { ...value, version: 1, builtIn: false };
    const parsed = WorkflowDefinitionSchema.safeParse(def);
    if (!parsed.success)
      return parsed.error.issues.map((i) => ({
        severity: 'error' as const,
        code: 'invalid_schema',
        message: `${i.path.join('.') || '(root)'}: ${i.message}`,
      }));
    return validateCustomWorkflow(parsed.data, roles, {
      builtinWorkflowKeys: BUILTIN_WORKFLOWS.map((w) => w.key),
      departments,
    }).map((i) => ({ ...i }));
  }, [value, roles, departments]);
  const shown = serverIssues && serverIssues.length > 0 ? serverIssues : issues;
  const { byStage, general } = groupIssues(shown);
  const flagged = new Set(
    [...byStage].filter(([, l]) => l.some((i) => i.severity === 'error')).map(([k]) => k),
  );
  const stageIds = value.stages.map((s) => s.id);
  const claimable = roles.filter((r) => !BUILTIN_ROLES.some((b) => b.key === r.key && r.key === 'devops'));

  const set = (patch: Partial<WorkflowDraftInput>) => onChange({ ...value, ...patch });
  const setStage = (i: number, patch: Partial<Stage>) =>
    set({ stages: value.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const renameStage = (i: number, newId: string) => {
    const old = value.stages[i]?.id as string;
    set({
      initialStage: value.initialStage === old ? newId : value.initialStage,
      stages: value.stages.map((s, j) => ({
        ...s,
        id: j === i ? newId : s.id,
        outcomes: s.outcomes.map((o) => (o.to === old ? { ...o, to: newId } : o)),
      })),
    });
  };
  const setOutcome = (i: number, k: number, patch: Partial<Outcome>) =>
    setStage(i, {
      outcomes: (value.stages[i] as Stage).outcomes.map((o, j) => (j === k ? { ...o, ...patch } : o)),
    });

  return (
    <div className="flex flex-col gap-4" data-testid="workflow-editor">
      <div className="grid gap-3 sm:grid-cols-3">
        <TextInput
          label="Key"
          value={value.key}
          disabled={readOnly}
          hint="Lowercase letters, digits, - and _"
          onChange={(e) => set({ key: e.target.value })}
        />
        <TextInput
          label="Name"
          value={value.name}
          disabled={readOnly}
          onChange={(e) => set({ name: e.target.value })}
        />
        <Select
          label="Department"
          value={value.department ?? ''}
          disabled={readOnly}
          onChange={(e) => set({ department: e.target.value || undefined })}
        >
          <option value="">None</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
      </div>
      <fieldset className="flex flex-wrap items-center gap-3 text-sm" disabled={readOnly}>
        <legend className="mb-1 text-xs font-medium text-muted">Card types</legend>
        {CARD_TYPES.map((t) => (
          <label key={t} className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={value.cardTypes.includes(t)}
              onChange={(e) =>
                set({
                  cardTypes: e.target.checked
                    ? [...value.cardTypes, t]
                    : value.cardTypes.filter((x) => x !== t),
                })
              }
            />
            {t}
          </label>
        ))}
      </fieldset>

      <section aria-label="Card fields" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Card fields</h3>
        {value.customFields.map((f, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id while their keys are being typed
          <div key={`${f.key}-${i}`} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_8rem_auto_auto]">
            <TextInput
              label="Field key"
              value={f.key}
              disabled={readOnly}
              onChange={(e) =>
                set({
                  customFields: value.customFields.map((x, j) =>
                    j === i ? { ...x, key: e.target.value } : x,
                  ),
                })
              }
            />
            <TextInput
              label="Label"
              value={f.label}
              disabled={readOnly}
              onChange={(e) =>
                set({
                  customFields: value.customFields.map((x, j) =>
                    j === i ? { ...x, label: e.target.value } : x,
                  ),
                })
              }
            />
            <Select
              label="Type"
              value={f.type}
              disabled={readOnly}
              onChange={(e) =>
                set({
                  customFields: value.customFields.map((x, j) =>
                    j === i ? { ...x, type: e.target.value as typeof f.type } : x,
                  ),
                })
              }
            >
              {['text', 'markdown', 'list', 'number', 'boolean', 'url-list'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
            <label className="mb-2 inline-flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={f.required}
                disabled={readOnly}
                onChange={(e) =>
                  set({
                    customFields: value.customFields.map((x, j) =>
                      j === i ? { ...x, required: e.target.checked } : x,
                    ),
                  })
                }
              />
              Required
            </label>
            {!readOnly && (
              <Button
                variant="ghost"
                onClick={() => set({ customFields: value.customFields.filter((_, j) => j !== i) })}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
        {!readOnly && (
          <div>
            <Button
              onClick={() =>
                set({
                  customFields: [
                    ...value.customFields,
                    { key: '', label: '', type: 'text', required: false },
                  ],
                })
              }
            >
              Add field
            </Button>
          </div>
        )}
      </section>

      <section aria-label="Stages" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Stages</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm" data-testid="stage-table">
            <thead className="text-xs text-subtle">
              <tr>
                <th className="py-1 pr-2">Stage</th>
                <th className="pr-2">Kind</th>
                <th className="pr-2">Claimed by</th>
                <th className="pr-2">Needs to enter</th>
                <th className="pr-2">Done when</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {value.stages.map((s, i) => (
                <tr
                  // biome-ignore lint/suspicious/noArrayIndexKey: a stage id can be duplicated while it is being edited
                  key={`${i}-${s.id}`}
                  data-testid={`stage-${s.id}`}
                  data-invalid={flagged.has(s.id) ? 'true' : undefined}
                  className={`align-top ${flagged.has(s.id) ? 'bg-danger-soft ' : ''}`}
                >
                  <td className="py-1 pr-2">
                    <input
                      aria-label={`Stage ${i + 1} label`}
                      className="w-32 rounded border border-control px-1.5 py-1"
                      value={s.label}
                      disabled={readOnly}
                      onChange={(e) => setStage(i, { label: e.target.value, column: e.target.value })}
                      onBlur={() => {
                        const id = stageId(s.label);
                        if (id && id !== s.id && !stageIds.includes(id)) renameStage(i, id);
                      }}
                    />
                    <div className="mt-0.5 font-mono text-xs text-subtle">{s.id}</div>
                  </td>
                  <td className="pr-2">
                    <select
                      aria-label={`Stage ${s.id} kind`}
                      className="rounded border border-control px-1 py-1"
                      value={s.kind}
                      disabled={readOnly}
                      onChange={(e) =>
                        setStage(i, {
                          kind: e.target.value as Stage['kind'],
                          claimRole: e.target.value === 'agent' ? s.claimRole : null,
                          ...(e.target.value === 'terminal' ? { outcomes: [] } : {}),
                        })
                      }
                    >
                      <option value="agent">agent</option>
                      <option value="manual">manual (first stage)</option>
                      <option value="terminal">terminal</option>
                    </select>
                  </td>
                  <td className="pr-2">
                    {s.kind === 'agent' ? (
                      <>
                        <select
                          aria-label={`Stage ${s.id} role`}
                          className="rounded border border-control px-1 py-1"
                          value={s.claimRole ?? ''}
                          disabled={readOnly}
                          onChange={(e) => setStage(i, { claimRole: e.target.value || null })}
                        >
                          <option value="">Choose a role</option>
                          {claimable.map((r) => (
                            <option key={r.key} value={r.key}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                        <label className="mt-1 flex items-center gap-1 text-xs">
                          <input
                            type="checkbox"
                            checked={s.seniorOnly}
                            disabled={readOnly}
                            onChange={(e) => setStage(i, { seniorOnly: e.target.checked })}
                          />
                          senior only
                        </label>
                      </>
                    ) : (
                      <span className="text-subtle">{s.kind === 'manual' ? 'the BA or you' : '-'}</span>
                    )}
                  </td>
                  <td className="pr-2">
                    <ListInput
                      bare
                      aria-label={`Stage ${s.id} required fields`}
                      placeholder="field keys"
                      value={s.requiredFields}
                      disabled={readOnly || s.kind === 'terminal'}
                      onChange={(v) => setStage(i, { requiredFields: v })}
                    />
                  </td>
                  <td className="pr-2">
                    <input
                      aria-label={`Stage ${s.id} done criteria`}
                      className="w-44 rounded border border-control px-1.5 py-1"
                      value={s.doneCriteria}
                      disabled={readOnly || s.kind === 'terminal'}
                      onChange={(e) => setStage(i, { doneCriteria: e.target.value })}
                    />
                  </td>
                  <td>
                    {!readOnly && value.stages.length > 2 && (
                      <Button
                        variant="ghost"
                        aria-label={`Remove stage ${s.id}`}
                        onClick={() =>
                          set({
                            stages: value.stages
                              .filter((_, j) => j !== i)
                              .map((x) => ({ ...x, outcomes: x.outcomes.filter((o) => o.to !== s.id) })),
                          })
                        }
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!readOnly && (
          <div>
            <Button
              onClick={() => {
                const n = stageCount + 1;
                setStageCount(n);
                const terminalAt = value.stages.findIndex((s) => s.kind === 'terminal');
                const next = blankStage(n);
                const stages = [...value.stages];
                stages.splice(terminalAt === -1 ? stages.length : terminalAt, 0, next);
                set({ stages });
              }}
            >
              Add stage
            </Button>
          </div>
        )}

        <h3 className="text-sm font-semibold">Outcomes and failure routes</h3>
        {value.stages
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => s.kind !== 'terminal')
          .map(({ s, i }) => (
            <div
              key={`${i}-${s.id}`}
              className="rounded-control border border-line p-2"
              data-testid={`outcomes-${s.id}`}
            >
              <p className="mb-1 text-xs font-medium text-muted">{s.label}</p>
              {s.outcomes.map((o, k) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: outcome ids are being edited
                <div key={`${k}-${o.id}`} className="mb-1 flex flex-wrap items-center gap-2 text-sm">
                  <input
                    aria-label={`${s.id} outcome ${k + 1} id`}
                    className="w-28 rounded border border-control px-1.5 py-1 font-mono"
                    value={o.id}
                    disabled={readOnly}
                    onChange={(e) => setOutcome(i, k, { id: e.target.value, label: e.target.value })}
                  />
                  <select
                    aria-label={`${s.id}.${o.id} kind`}
                    className="rounded border border-control px-1 py-1"
                    value={o.kind}
                    disabled={readOnly}
                    onChange={(e) => setOutcome(i, k, { kind: e.target.value as Outcome['kind'] })}
                  >
                    <option value="success">success</option>
                    <option value="failure">failure</option>
                  </select>
                  <span aria-hidden="true">goes to</span>
                  <select
                    aria-label={`${s.id}.${o.id} goes to`}
                    className="rounded border border-control px-1 py-1"
                    value={o.to}
                    disabled={readOnly}
                    onChange={(e) => setOutcome(i, k, { to: e.target.value })}
                  >
                    {stageIds.map((id) => (
                      <option key={id}>{id}</option>
                    ))}
                  </select>
                  <label className="inline-flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={o.rework}
                      disabled={readOnly}
                      onChange={(e) => setOutcome(i, k, { rework: e.target.checked })}
                    />
                    counts as rework
                  </label>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      aria-label={`Remove outcome ${o.id} of ${s.id}`}
                      onClick={() => setStage(i, { outcomes: s.outcomes.filter((_, j) => j !== k) })}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              ))}
              {!readOnly && (
                <Button
                  aria-label={`Add outcome to ${s.id}`}
                  onClick={() =>
                    setStage(i, {
                      outcomes: [
                        ...s.outcomes,
                        {
                          ...blankOutcome(stageIds[i + 1] ?? stageIds[0] ?? s.id, s.outcomes.length + 1),
                          ...(i === 0 && s.kind === 'manual' ? { event: 'CardSpecified' as const } : {}),
                        },
                      ],
                    })
                  }
                >
                  Add outcome
                </Button>
              )}
            </div>
          ))}
      </section>

      <section aria-label="Graph preview" className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Graph preview</h3>
        <WorkflowGraph def={value} flagged={flagged} />
      </section>

      <section aria-label="Validation" data-testid="validation" data-errors={errorCount(shown)}>
        <h3 className="text-sm font-semibold">Validation</h3>
        {errorCount(shown) === 0 && (
          <p className="text-sm text-success" data-testid="validation-ok">
            No errors: every stage can be claimed and reached, and every failure route ends.
          </p>
        )}
        {shown.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {general.map((i) => (
              <Issue key={`${i.code}-${i.message}`} issue={i} />
            ))}
            {[...byStage].flatMap(([id, list]) =>
              list.map((i) => <Issue key={`${id}-${i.code}-${i.outcomeId ?? ''}`} issue={i} />),
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

function Issue({ issue }: { issue: DefinitionIssue }) {
  return (
    <li
      data-testid="issue"
      data-code={issue.code}
      className={issue.severity === 'error' ? 'text-danger ' : 'text-warning '}
    >
      <Badge tone={issue.severity === 'error' ? 'red' : 'amber'}>{issue.severity}</Badge>{' '}
      {issue.stageId && <span className="font-mono text-xs">[{issue.stageId}] </span>}
      {issue.message}
    </li>
  );
}
