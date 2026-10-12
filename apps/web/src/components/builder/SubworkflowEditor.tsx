import type { SubworkflowTargetsResponse } from '@aom/shared';
import { Plus } from 'lucide-react';
import { CARD_TYPE_LABEL, failedRouteIndex, setFailedRoute } from '../../lib/builder.ts';
import {
  addFieldIn,
  addFieldOut,
  childFieldChoices,
  configOf,
  type FieldsInRow,
  parentFieldChoices,
  removeFieldIn,
  removeFieldOut,
  setCardType,
  setFieldIn,
  setFieldOut,
  setMode,
  setOnFailure,
  setStart,
  setTarget,
  setTargetProject,
  sourceKindOf,
  sourceOfKind,
  startHint,
} from '../../lib/subworkflowStep.ts';
import { Button, Select, TextInput } from '../ui.tsx';
import type { SubworkflowSlotContext } from './StepCard.tsx';

type Kind = string;

/** The value a fresh "fixed value" mapping starts with, for the child field's kind. */
const defaultValue = (kind: Kind | undefined): unknown =>
  kind === 'boolean' ? false : kind === 'number' ? 0 : kind === 'list' || kind === 'url-list' ? [] : '';

const showList = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : '');
const parseList = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export interface SubworkflowEditorProps {
  ctx: SubworkflowSlotContext;
  /** What can be started and where; undefined while loading or when it could not be loaded. */
  targets: SubworkflowTargetsResponse | undefined;
  loading?: boolean;
  failed?: boolean;
  /** Key of the workflow being edited: it cannot start itself. */
  selfKey: string;
}

/**
 * The editor of a "Start another workflow" step (docs/design/workflow-builder.md section 4): which workflow, in which
 * project, whether to wait, what to pass in and bring back, and what happens when the other card is cancelled. The
 * "when finished, go to" route is the step's ordinary next route (RouteEditor); the "cancelled" route is chosen here.
 */
export function SubworkflowEditor({ ctx, targets, loading, failed, selfKey }: SubworkflowEditorProps) {
  const { step, model, onChange, readOnly, describedBy } = ctx;
  const uid = step.uid;
  const cfg = configOf(step);
  const sub = describedBy('subworkflow');
  const subProps = { 'aria-describedby': sub, 'aria-invalid': sub ? (true as const) : undefined };
  const projects = targets?.projects ?? [];
  const workflows = (targets?.workflows ?? []).filter((w) => w.key !== selfKey);
  const target = targets?.workflows.find((w) => w.key === cfg.workflowKey);
  const projectId = cfg.project === 'same' ? 'same' : cfg.project.projectId;
  const parentFields = parentFieldChoices(model);
  const childFields = childFieldChoices(target);
  const hint = startHint(cfg, target);
  const others = model.steps.filter((s) => s.uid !== uid);
  const failedIndex = failedRouteIndex(step);
  const failedTo = failedIndex === -1 ? '' : (step.routes[failedIndex]?.to ?? '');
  const id = (s: string) => `sub-${uid}-${s}`;
  const childLabel = (key: string) => target?.fields.find((f) => f.key === key)?.label ?? key;
  const kindOfChild = (key: string) => target?.fields.find((f) => f.key === key)?.kind;
  const usedTo = new Set(cfg.fieldsIn.map((r) => r.to));

  return (
    <div className="flex flex-col gap-4" data-testid={`subworkflow-editor-${uid}`}>
      {loading && (
        <p className="text-sm text-subtle" role="status">
          Loading the workflows and projects you can choose from.
        </p>
      )}
      {failed && (
        <p className="text-sm text-danger" role="alert">
          The list of workflows could not be loaded. Reload the page to choose one.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          id={id('workflow')}
          label="Workflow to start"
          value={cfg.workflowKey}
          disabled={readOnly}
          hint="A new card is created in this workflow. Only approved workflows are listed."
          onChange={(e) => onChange(setTarget(model, uid, e.target.value))}
          {...subProps}
        >
          <option value="">Choose a workflow</option>
          {cfg.workflowKey && !workflows.some((w) => w.key === cfg.workflowKey) && (
            <option value={cfg.workflowKey}>{cfg.workflowKey} (not found)</option>
          )}
          {workflows.map((w) => (
            <option key={w.key} value={w.key}>
              {w.name}
            </option>
          ))}
        </Select>
        <Select
          id={id('project')}
          label="Where the new card goes"
          value={projectId}
          disabled={readOnly}
          hint="Another project must have that workflow switched on."
          onChange={(e) => onChange(setTargetProject(model, uid, e.target.value))}
          {...subProps}
        >
          <option value="same">This project (the one the card is in)</option>
          {projectId !== 'same' && !projects.some((p) => p.id === projectId) && (
            <option value={projectId}>A project you are not a member of</option>
          )}
          {projects.map((p) => {
            const off = !!cfg.workflowKey && !p.enabledWorkflows.includes(cfg.workflowKey);
            return (
              <option key={p.id} value={p.id} disabled={off && p.id !== projectId}>
                {p.name} ({p.key}){off ? ': workflow not switched on there' : ''}
              </option>
            );
          })}
        </Select>
        <Select
          id={id('card-type')}
          label="Kind of card to create"
          value={cfg.cardType ?? ''}
          disabled={readOnly || !target}
          hint="By default the new card has the same kind as this one, when the other workflow handles it."
          onChange={(e) => onChange(setCardType(model, uid, e.target.value))}
          {...subProps}
        >
          <option value="">Same as this card</option>
          {cfg.cardType && !target?.cardTypes.includes(cfg.cardType) && (
            <option value={cfg.cardType}>
              {CARD_TYPE_LABEL[cfg.cardType] ?? cfg.cardType} (not handled)
            </option>
          )}
          {(target?.cardTypes ?? []).map((t) => (
            <option key={t} value={t}>
              {CARD_TYPE_LABEL[t] ?? t}
            </option>
          ))}
        </Select>
        <Select
          id={id('start')}
          label="Start the new card"
          value={cfg.start ?? ''}
          disabled={readOnly}
          hint={
            hint
              ? `Left on automatic it starts ${hint.effective === 'queued' ? 'ready for work' : 'as a draft'}${
                  hint.missing.length > 0 && !cfg.start
                    ? ` because it still needs: ${hint.missing.map(childLabel).join(', ')}`
                    : ''
                }.`
              : 'Choose the workflow first to see how it will start.'
          }
          onChange={(e) => onChange(setStart(model, uid, e.target.value as 'draft' | 'queued' | ''))}
          {...subProps}
        >
          <option value="">Automatically</option>
          <option value="queued">Ready for work at once</option>
          <option value="draft">As a draft, for someone to complete first</option>
        </Select>
      </div>

      <fieldset className="flex flex-col gap-1" disabled={readOnly} {...subProps}>
        <legend className="text-sm font-medium">While the new card is being worked on, this card</legend>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={id('mode')}
            checked={cfg.mode === 'wait'}
            onChange={() => onChange(setMode(model, uid, 'wait'))}
          />
          Waits for it
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={id('mode')}
            checked={cfg.mode === 'continue'}
            onChange={() => onChange(setMode(model, uid, 'continue'))}
          />
          Carries on at once
        </label>
      </fieldset>

      <section aria-labelledby={id('in-title')} className="flex flex-col gap-2">
        <div>
          <h4 id={id('in-title')} className="text-sm font-medium">
            Information to pass to the new card
          </h4>
          <p className="text-xs text-subtle">
            Fill fields of the new card from this card, with a fixed value, or with text that includes{' '}
            <code>{'{card.ref}'}</code>, <code>{'{card.title}'}</code> or <code>{'{card.fields.name}'}</code>.
          </p>
        </div>
        {cfg.fieldsIn.length === 0 && <p className="text-sm text-subtle">Nothing is passed on yet.</p>}
        <ul className="flex flex-col gap-3">
          {cfg.fieldsIn.map((row, i) => {
            const n = i + 1;
            const kind = kindOfChild(row.to);
            const sk = sourceKindOf(row.from);
            const set = (patch: Partial<FieldsInRow>) =>
              onChange(setFieldIn(model, uid, i, { ...row, ...patch } as FieldsInRow));
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
                key={i}
                data-testid={`field-in-${uid}-${i}`}
                className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1.4fr_auto]"
              >
                <Select
                  label={`Information ${n}: field of the new card`}
                  value={row.to}
                  disabled={readOnly}
                  onChange={(e) =>
                    onChange(
                      setFieldIn(model, uid, i, {
                        to: e.target.value,
                        from:
                          'value' in row.from
                            ? { value: defaultValue(kindOfChild(e.target.value)) }
                            : row.from,
                      }),
                    )
                  }
                >
                  {!childFields.some((f) => f.key === row.to) && (
                    <option value={row.to}>{row.to} (not found)</option>
                  )}
                  {childFields.map((f) => (
                    <option key={f.key} value={f.key} disabled={usedTo.has(f.key) && f.key !== row.to}>
                      {f.label}
                      {f.required ? ' (needed)' : ''}
                    </option>
                  ))}
                </Select>
                <Select
                  label={`Information ${n}: comes from`}
                  value={sk}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = e.target.value as typeof sk;
                    set({
                      from:
                        next === 'value' ? { value: defaultValue(kind) } : sourceOfKind(next, parentFields),
                    });
                  }}
                >
                  <option value="field">A field of this card</option>
                  <option value="value">A fixed value</option>
                  <option value="template">Text with details of this card</option>
                </Select>
                {'field' in row.from ? (
                  <Select
                    label={`Information ${n}: which field`}
                    value={row.from.field}
                    disabled={readOnly}
                    onChange={(e) => set({ from: { field: e.target.value } })}
                  >
                    {!parentFields.some((f) => f.key === (row.from as { field: string }).field) && (
                      <option value={row.from.field}>{row.from.field} (not found)</option>
                    )}
                    {parentFields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                ) : 'template' in row.from ? (
                  <TextInput
                    label={`Information ${n}: text`}
                    value={row.from.template}
                    disabled={readOnly}
                    placeholder="{card.ref}: {card.title}"
                    onChange={(e) => set({ from: { template: e.target.value } })}
                  />
                ) : kind === 'boolean' ? (
                  <Select
                    label={`Information ${n}: value`}
                    value={row.from.value === true ? 'yes' : 'no'}
                    disabled={readOnly}
                    onChange={(e) => set({ from: { value: e.target.value === 'yes' } })}
                  >
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </Select>
                ) : kind === 'number' ? (
                  <TextInput
                    label={`Information ${n}: value`}
                    type="number"
                    value={typeof row.from.value === 'number' ? row.from.value : ''}
                    disabled={readOnly}
                    onChange={(e) =>
                      set({ from: { value: e.target.value === '' ? 0 : Number(e.target.value) } })
                    }
                  />
                ) : kind === 'list' || kind === 'url-list' ? (
                  <TextInput
                    label={`Information ${n}: value`}
                    value={showList(row.from.value)}
                    disabled={readOnly}
                    hint="Separate the items with commas."
                    onChange={(e) => set({ from: { value: parseList(e.target.value) } })}
                  />
                ) : (
                  <TextInput
                    label={`Information ${n}: value`}
                    value={typeof row.from.value === 'string' ? row.from.value : ''}
                    disabled={readOnly}
                    onChange={(e) => set({ from: { value: e.target.value } })}
                  />
                )}
                {!readOnly && (
                  <Button
                    variant="ghost"
                    aria-label={`Remove information ${n} (${childLabel(row.to)})`}
                    onClick={() => onChange(removeFieldIn(model, uid, i))}
                  >
                    Remove
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {!readOnly && (
          <div>
            <Button
              disabled={!target || childFields.every((f) => usedTo.has(f.key))}
              onClick={() => {
                const next = childFields.find((f) => !usedTo.has(f.key));
                if (!next) return;
                onChange(addFieldIn(model, uid, next.key, defaultValue(next.kind)));
              }}
            >
              <Plus aria-hidden="true" className="size-4" />
              Pass on information
            </Button>
          </div>
        )}
      </section>

      {cfg.mode === 'wait' && (
        <section
          aria-labelledby={id('out-title')}
          className="flex flex-col gap-2"
          data-testid={`field-out-${uid}`}
        >
          <div>
            <h4 id={id('out-title')} className="text-sm font-medium">
              Information to bring back
            </h4>
            <p className="text-xs text-subtle">
              When the new card finishes, copy these fields back onto this card.
            </p>
          </div>
          {cfg.fieldsOut.length === 0 && <p className="text-sm text-subtle">Nothing is brought back.</p>}
          <ul className="flex flex-col gap-3">
            {cfg.fieldsOut.map((row, i) => {
              const n = i + 1;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
                <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <Select
                    label={`Result ${n}: field of the new card`}
                    value={row.from}
                    disabled={readOnly}
                    onChange={(e) => onChange(setFieldOut(model, uid, i, { ...row, from: e.target.value }))}
                  >
                    {!childFields.some((f) => f.key === row.from) && (
                      <option value={row.from}>{row.from} (not found)</option>
                    )}
                    {childFields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                  <Select
                    label={`Result ${n}: store it in this card's`}
                    value={row.to}
                    disabled={readOnly}
                    onChange={(e) => onChange(setFieldOut(model, uid, i, { ...row, to: e.target.value }))}
                  >
                    {!parentFields.some((f) => f.key === row.to) && (
                      <option value={row.to}>{row.to} (not found)</option>
                    )}
                    {parentFields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      aria-label={`Remove result ${n} (${childLabel(row.from)})`}
                      onClick={() => onChange(removeFieldOut(model, uid, i))}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {!readOnly && (
            <div>
              <Button
                disabled={!target || parentFields.length === 0 || childFields.length === 0}
                onClick={() =>
                  onChange(
                    addFieldOut(
                      model,
                      uid,
                      (childFields[0] as { key: string }).key,
                      (parentFields[0] as { key: string }).key,
                    ),
                  )
                }
              >
                <Plus aria-hidden="true" className="size-4" />
                Bring back information
              </Button>
            </div>
          )}
        </section>
      )}

      {cfg.mode === 'wait' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            id={id('on-failure')}
            label="If the new card is cancelled"
            value={cfg.onFailure}
            disabled={readOnly}
            onChange={(e) => onChange(setOnFailure(model, uid, e.target.value as 'fail' | 'continue'))}
            {...subProps}
          >
            <option value="fail">This step fails</option>
            <option value="continue">Carry on as if it finished</option>
          </Select>
          {cfg.onFailure === 'fail' && (
            <Select
              id={id('failed-to')}
              label="When it fails, go to"
              value={failedTo}
              disabled={readOnly}
              aria-describedby={describedBy('route')}
              aria-invalid={describedBy('route') ? true : undefined}
              onChange={(e) => onChange(setFailedRoute(model, uid, e.target.value || null))}
            >
              {failedTo === '' && <option value="">Choose a step</option>}
              {others.map((s) => (
                <option key={s.uid} value={s.uid}>
                  {model.steps.findIndex((x) => x.uid === s.uid) + 1}. {s.label || 'Untitled step'}
                </option>
              ))}
              {failedTo && !others.some((s) => s.uid === failedTo) && (
                <option value={failedTo}>A step that no longer exists</option>
              )}
            </Select>
          )}
        </div>
      )}
    </div>
  );
}
