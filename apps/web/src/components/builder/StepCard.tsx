import type { ExplainField, FrozenIds, RoleDefinition } from '@aom/shared';
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useOrgMembers } from '../../api/queries/orgs.ts';
import {
  type BuilderIssue,
  type BuilderModel,
  type BuilderStep,
  humanPurposeOf,
  KIND_LABEL,
  nextIndex,
  sendBackIndex,
  setApprover,
  setFirstStep,
  setHumanPurpose,
  setStepKind,
  toggleRequired,
  updateStep,
} from '../../lib/builder.ts';
import { Badge, Button, Select, TextArea, TextInput } from '../ui.tsx';
import { RouteEditor } from './RouteEditor.tsx';

/**
 * Context handed to the sub-workflow editor slot. WP5 and later plug a real editor into `renderSubworkflowEditor`;
 * until then a sub-workflow step (from a BA draft or the Advanced table) shows a read-only summary.
 */
export interface SubworkflowSlotContext {
  step: BuilderStep;
  model: BuilderModel;
  onChange: (m: BuilderModel) => void;
  readOnly: boolean;
  describedBy: (field: ExplainField) => string | undefined;
}

export interface StepCardProps {
  index: number;
  step: BuilderStep;
  model: BuilderModel;
  onChange: (m: BuilderModel) => void;
  /** Issues pinned on this step. */
  issues: readonly BuilderIssue[];
  roles: readonly RoleDefinition[];
  /** Role keys that have at least one hired agent; undefined: not known, so no warning. */
  hiredRoleKeys?: ReadonlySet<string>;
  /** The final stage id of this step. */
  stageId: string;
  frozen?: FrozenIds;
  open: boolean;
  onToggle: () => void;
  readOnly?: boolean;
  showWorktree?: boolean;
  renderSubworkflowEditor?: (ctx: SubworkflowSlotContext) => ReactNode;
  onInsertAfter: () => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  canRemove: boolean;
}

const APPROVER_LABEL = {
  org_owner: 'The organization Owner',
  project_owner: 'The project owner',
  starter: 'The person who started the card',
  member: 'A named member',
} as const;

/** The member picker of "A named member" (only mounted for that choice, so it fetches only then). */
function MemberPick({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (userId: string) => void;
  disabled: boolean;
}) {
  const members = useOrgMembers();
  return (
    <Select label="Which member" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a member</option>
      {(members.data ?? []).map((m) => (
        <option key={m.userId} value={m.userId}>
          {m.displayName}
        </option>
      ))}
    </Select>
  );
}

export function StepCard(p: StepCardProps) {
  const { step, model, onChange, issues, readOnly = false } = p;
  const uid = step.uid;
  const issuesId = `step-${uid}-issues`;
  const titleId = `step-${uid}-title`;
  const bodyId = `step-${uid}-body`;
  const isInitial = model.initial === uid;
  const locked = p.frozen?.stages.has(p.stageId) ?? false;
  const describedBy = (f: ExplainField) => (issues.some((i) => i.field === f) ? issuesId : undefined);
  const fieldProps = (f: ExplainField) => ({
    'aria-describedby': describedBy(f),
    'aria-invalid': describedBy(f) ? (true as const) : undefined,
  });
  const set = (patch: Partial<BuilderStep>) => onChange(updateStep(model, uid, patch));
  const errors = issues.filter((i) => i.severity === 'error').length;
  const roleDef = step.role ? p.roles.find((r) => r.key === step.role) : undefined;
  const hired = step.role && p.hiredRoleKeys ? p.hiredRoleKeys.has(step.role) : true;
  const label = step.label.trim() || 'Untitled step';
  const next = step.routes[nextIndex(step)];
  const back = step.routes[sendBackIndex(step)];
  const nameOf = (to?: string) => model.steps.find((s) => s.uid === to)?.label || undefined;
  const summary = [
    step.kind === 'agent' ? (roleDef?.name ?? step.role ?? 'no role chosen yet') : KIND_LABEL[step.kind],
    next ? `then ${nameOf(next.to) ?? 'a missing step'}` : step.kind === 'terminal' ? '' : 'no next step',
    back ? `sent back to ${nameOf(back.to) ?? 'a missing step'} if not good enough` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const kinds: BuilderStep['kind'][] = [
    ...(isInitial || step.kind === 'manual' ? (['manual'] as const) : []),
    'agent',
    ...(step.kind === 'subworkflow' || p.renderSubworkflowEditor ? (['subworkflow'] as const) : []),
    'terminal',
  ];
  const purpose = humanPurposeOf(step);
  /** The picker value: a person's step is chosen by what the person does. */
  const pick = step.kind === 'human' ? (purpose ?? 'approval') : step.kind;
  const approver = step.extra.human?.approver;

  return (
    <li id={`step-${uid}`} data-testid={`step-${uid}`}>
      <section
        aria-labelledby={titleId}
        data-invalid={errors > 0 ? 'true' : undefined}
        className={`rounded-card border bg-surface p-3 ${errors > 0 ? 'border-danger' : 'border-line'}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">Step {p.index + 1}</Badge>
          <h3 id={titleId} tabIndex={-1} className="min-w-0 flex-1 truncate text-base font-semibold">
            {label}
          </h3>
          {isInitial && <Badge tone="blue">First step</Badge>}
          {step.kind === 'terminal' && <Badge tone="green">Finished</Badge>}
          {locked && (
            <span
              className="inline-flex items-center gap-1 text-xs text-subtle"
              title="This step is part of an approved version, so its internal name never changes when you rename it."
            >
              <Lock aria-hidden="true" className="size-3" />
              <span className="sr-only">Its internal name is locked. </span>
              Approved
            </span>
          )}
          {errors > 0 && (
            <Badge tone="red" icon={<AlertCircle aria-hidden="true" className="size-3" />}>
              {errors === 1 ? '1 problem' : `${errors} problems`}
            </Badge>
          )}
        </div>
        {!p.open && summary && <p className="mt-1 text-sm text-muted">{summary}</p>}
        {issues.length > 0 && (
          <ul id={issuesId} className="mt-2 flex flex-col gap-1 text-sm" data-testid={`step-issues-${uid}`}>
            {issues.map((i, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the same sentence can appear twice
              <li key={`${i.code}-${n}`} data-testid="step-issue" className="flex items-start gap-1.5">
                {i.severity === 'error' ? (
                  <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
                ) : (
                  <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
                )}
                <span className={i.severity === 'error' ? 'text-danger' : 'text-warning'}>
                  <span className="sr-only">{i.severity === 'error' ? 'Problem: ' : 'Tip: '}</span>
                  {i.text}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`Actions for ${label}`}>
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={p.open}
            aria-controls={bodyId}
            onClick={p.onToggle}
          >
            {p.open ? (
              <ChevronDown aria-hidden="true" className="size-4" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-4" />
            )}
            {p.open ? 'Hide details' : 'Edit details'}
            <span className="sr-only"> of {label}</span>
          </Button>
          {!readOnly && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={p.index === 0}
                aria-label={`Move ${label} up`}
                onClick={() => p.onMove(-1)}
              >
                Move up
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={p.index === model.steps.length - 1}
                aria-label={`Move ${label} down`}
                onClick={() => p.onMove(1)}
              >
                Move down
              </Button>
              {step.kind !== 'terminal' && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Add a step after ${label}`}
                  onClick={p.onInsertAfter}
                >
                  Add a step after
                </Button>
              )}
              <Button
                size="sm"
                variant="danger-ghost"
                disabled={!p.canRemove}
                aria-label={`Remove ${label}`}
                onClick={p.onRemove}
              >
                Remove
              </Button>
            </>
          )}
        </div>

        {p.open && (
          <div id={bodyId} className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
            <TextInput
              id={`step-${uid}-label`}
              label="Step name"
              value={step.label}
              disabled={readOnly}
              onChange={(e) => set({ label: e.target.value })}
              {...fieldProps('label')}
            />
            <Select
              label="What kind of step is this?"
              value={pick}
              disabled={readOnly}
              onChange={(e) => {
                const v = e.target.value;
                onChange(
                  v === 'approval' || v === 'qa'
                    ? setHumanPurpose(model, uid, v)
                    : setStepKind(model, uid, v as BuilderStep['kind']),
                );
              }}
              {...fieldProps('kind')}
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
              <option value="approval">A person approves it on the desk</option>
              <option value="qa">A person tests it (pass, skip or send back)</option>
            </Select>

            {step.kind === 'human' && purpose === 'approval' && (
              <div className="flex flex-col gap-2" data-testid={`approval-${uid}`}>
                <Select
                  label="Who approves"
                  value={approver?.kind ?? 'org_owner'}
                  disabled={readOnly}
                  onChange={(e) => {
                    const k = e.target.value as keyof typeof APPROVER_LABEL;
                    onChange(
                      setApprover(
                        model,
                        uid,
                        k === 'member'
                          ? { kind: 'member', userId: approver?.kind === 'member' ? approver.userId : '' }
                          : { kind: k },
                      ),
                    );
                  }}
                  {...fieldProps('role')}
                >
                  {Object.entries(APPROVER_LABEL).map(([k, text]) => (
                    <option key={k} value={k}>
                      {text}
                    </option>
                  ))}
                </Select>
                {approver?.kind === 'member' && (
                  <MemberPick
                    value={approver.userId}
                    disabled={readOnly}
                    onChange={(userId) => onChange(setApprover(model, uid, { kind: 'member', userId }))}
                  />
                )}
                <p className="text-xs text-subtle">
                  The card waits here and shows on that person's desk. If they send it back they must say why:
                  choose below which earlier step it goes back to. The Owner and Admins can always act too.
                </p>
              </div>
            )}
            {step.kind === 'human' && purpose === 'qa' && (
              <p className="text-sm text-muted" data-testid={`qa-step-${uid}`}>
                The person who started the card tests it and passes it, skips the test or sends it back.
              </p>
            )}

            {step.kind === 'manual' && (
              <p className="text-sm text-muted">
                The card waits here until you or the BA fill it in and mark it ready.
              </p>
            )}

            {step.kind !== 'terminal' && step.kind !== 'subworkflow' && (
              <TextArea
                label={
                  step.kind === 'manual'
                    ? 'What needs to be known first'
                    : 'What to do, and what "done" looks like'
                }
                rows={3}
                value={step.doneCriteria}
                disabled={readOnly}
                onChange={(e) => set({ doneCriteria: e.target.value })}
                {...fieldProps('doneCriteria')}
              />
            )}

            {step.kind === 'agent' && (
              <div className="flex flex-col gap-2">
                <Select
                  label="Who does it"
                  value={step.role ?? ''}
                  disabled={readOnly}
                  onChange={(e) => set({ role: e.target.value || null })}
                  {...fieldProps('role')}
                >
                  <option value="">Choose a role</option>
                  {step.role && !roleDef && <option value={step.role}>{step.role} (not found)</option>}
                  {p.roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-subtle">
                  A role may only work steps it lists as its own.{' '}
                  <Link to="/org?tab=roles" className="underline">
                    Create or change roles
                  </Link>
                </p>
                {step.role && !hired && (
                  <p className="text-sm text-warning" data-testid={`unhired-${uid}`}>
                    No agent with the {roleDef?.name ?? step.role} role is hired yet, so cards would wait
                    here.{' '}
                    <Link to={`/agents?hire=${encodeURIComponent(step.role)}`} className="underline">
                      Hire one
                    </Link>
                  </p>
                )}
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={step.seniorOnly}
                    disabled={readOnly}
                    onChange={(e) => set({ seniorOnly: e.target.checked })}
                    {...fieldProps('seniorOnly')}
                  />
                  Only senior staff
                </label>
              </div>
            )}

            {step.kind === 'subworkflow' && (
              <div className="flex flex-col gap-2" data-testid={`subworkflow-${uid}`}>
                {p.renderSubworkflowEditor ? (
                  p.renderSubworkflowEditor({ step, model, onChange, readOnly, describedBy })
                ) : (
                  <p className="rounded-control bg-sunken p-2 text-sm">
                    {step.subworkflow
                      ? `Starts a card in the workflow "${step.subworkflow.workflowKey}" and ${
                          (step.subworkflow.mode ?? 'wait') === 'wait'
                            ? 'waits for it to finish'
                            : 'carries on at once'
                        }. Change the details under Advanced.`
                      : 'This step starts another workflow. Choose which one under Advanced.'}
                  </p>
                )}
              </div>
            )}

            {step.kind !== 'terminal' && model.fields.length > 0 && (
              <fieldset className="flex flex-col gap-1" {...fieldProps('requiredFields')}>
                <legend className="text-sm font-medium">Must be filled in before this step</legend>
                {model.fields.map((f) => (
                  <label key={f.uid} className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={step.requiredFields.includes(f.uid)}
                      disabled={readOnly}
                      onChange={(e) => onChange(toggleRequired(model, uid, f.uid, e.target.checked))}
                    />
                    {f.label || f.key || 'Unnamed information'}
                  </label>
                ))}
              </fieldset>
            )}
            {step.requiredFields.some((f) => !model.fields.some((x) => x.uid === f)) && (
              <p className="text-xs text-subtle">
                Also needs:{' '}
                {step.requiredFields.filter((f) => !model.fields.some((x) => x.uid === f)).join(', ')}{' '}
                (built-in card information).
              </p>
            )}

            <RouteEditor
              step={step}
              model={model}
              onChange={onChange}
              readOnly={readOnly}
              describedBy={describedBy}
            />

            {p.showWorktree && step.kind === 'agent' && (
              <Select
                label="Works in the code"
                value={step.worktree}
                disabled={readOnly}
                onChange={(e) => set({ worktree: e.target.value as BuilderStep['worktree'] })}
              >
                <option value="none">Not in the code</option>
                <option value="create">In a new copy of the code</option>
                <option value="reuse">In the same copy as the step before</option>
              </Select>
            )}

            {step.kind === 'agent' && (
              <label className="flex min-h-9 items-center gap-2 text-sm" data-testid="step-environment">
                <input
                  type="checkbox"
                  checked={step.environment}
                  disabled={readOnly}
                  onChange={(e) => set({ environment: e.target.checked })}
                />
                Needs a running environment (Run &amp; test settings)
              </label>
            )}

            {(step.kind === 'agent' || !isInitial) && (
              <details className="text-sm">
                <summary className="cursor-pointer font-medium text-muted">More settings (advanced)</summary>
                <div className="mt-2 flex flex-col gap-2">
                  {step.kind === 'agent' && (
                    <TextInput
                      label="Longest a single work session may run (minutes)"
                      type="number"
                      min={5}
                      max={480}
                      value={step.maxShiftMinutes}
                      disabled={readOnly}
                      onChange={(e) =>
                        set({ maxShiftMinutes: Number(e.target.value) || step.maxShiftMinutes })
                      }
                    />
                  )}
                  {!isInitial && !readOnly && (
                    <div>
                      <Button onClick={() => onChange(setFirstStep(model, uid))}>
                        Make this the first step
                      </Button>
                    </div>
                  )}
                </div>
              </details>
            )}
          </div>
        )}
      </section>
    </li>
  );
}
