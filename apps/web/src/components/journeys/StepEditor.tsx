import type { JourneyCondition, JourneyDefinition, JourneyHandoff, JourneyStep } from '@aom/shared';
import { ArrowDown, ArrowUp, Plus, Repeat, Trash2 } from 'lucide-react';
import { isLoop } from '../../lib/journeys.ts';
import { Badge, Button, Select, TextInput } from '../ui.tsx';
import { StepSettings } from './StepSettings.tsx';

export interface WorkflowOption {
  key: string;
  name: string;
}
export interface PlaybookOption {
  key: string;
  name: string;
}

const OPS: Array<[JourneyCondition['op'], string]> = [
  ['equals', 'equals'],
  ['not_equals', 'does not equal'],
  ['is_set', 'is filled in'],
  ['is_not_set', 'is empty'],
  ['lt', 'is less than'],
  ['gte', 'is at least'],
];

function ConditionEditor({
  value,
  onChange,
}: {
  value: JourneyCondition;
  onChange: (c: JourneyCondition | undefined) => void;
}) {
  const needsValue = value.op !== 'is_set' && value.op !== 'is_not_set';
  return (
    <div className="grid gap-2 rounded-control border border-line p-3 sm:grid-cols-4">
      <Select
        label="Look at"
        value={value.source}
        onChange={(e) => onChange({ ...value, source: e.target.value as JourneyCondition['source'] })}
      >
        <option value="card">The finished card</option>
        <option value="record">The record</option>
      </Select>
      <TextInput
        label={value.source === 'record' ? 'Record field (type, status, visits)' : 'Card field'}
        value={value.field}
        autoCapitalize="none"
        autoCorrect="off"
        enterKeyHint="next"
        onChange={(e) => onChange({ ...value, field: e.target.value })}
      />
      <Select
        label="Condition"
        value={value.op}
        onChange={(e) => onChange({ ...value, op: e.target.value as JourneyCondition['op'] })}
      >
        {OPS.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </Select>
      {needsValue && (
        <TextInput
          label="Value"
          value={value.value === undefined ? '' : String(value.value)}
          inputMode={value.op === 'lt' || value.op === 'gte' ? 'decimal' : 'text'}
          enterKeyHint="done"
          onChange={(e) => {
            const raw = e.target.value;
            const v: JourneyCondition['value'] =
              value.op === 'lt' || value.op === 'gte'
                ? raw === ''
                  ? undefined
                  : Number(raw)
                : raw === 'true'
                  ? true
                  : raw === 'false'
                    ? false
                    : raw;
            onChange({ ...value, value: v });
          }}
        />
      )}
      <div className="sm:col-span-4">
        <Button variant="secondary" size="sm" type="button" onClick={() => onChange(undefined)}>
          Remove condition
        </Button>
      </div>
    </div>
  );
}

function HandoffRow({
  def,
  h,
  onUpdate,
  onMove,
  onRemove,
}: {
  def: JourneyDefinition;
  h: JourneyHandoff;
  onUpdate: (patch: Partial<JourneyHandoff>) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
}) {
  const loop = isLoop(def, h);
  return (
    <li
      className="flex flex-col gap-2 rounded-control border border-line bg-sunken/40 p-3"
      data-testid={`handoff-${h.id}`}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Select
          label="When this step is"
          value={h.on}
          onChange={(e) => onUpdate({ on: e.target.value as JourneyHandoff['on'] })}
        >
          <option value="done">done</option>
          <option value="cancelled">cancelled</option>
          <option value="any">either</option>
          {def.steps.find((x) => x.id === h.from)?.kind === 'gate' && (
            <>
              <option value="approved">approved</option>
              <option value="rejected">rejected</option>
            </>
          )}
          {def.steps.find((x) => x.id === h.from)?.kind === 'webhook_call' && (
            <option value="failed">failed</option>
          )}
        </Select>
        <Select label="Go to" value={h.to} onChange={(e) => onUpdate({ to: e.target.value })}>
          {def.steps.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
          <option value="end">End of the journey</option>
        </Select>
      </div>
      {h.condition ? (
        <ConditionEditor
          value={h.condition}
          onChange={(c) => onUpdate({ condition: c } as Partial<JourneyHandoff>)}
        />
      ) : (
        <div>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => onUpdate({ condition: { source: 'card', field: '', op: 'equals', value: '' } })}
          >
            Only if…
          </Button>
        </div>
      )}
      <TextInput
        label="Label (optional)"
        value={h.label ?? ''}
        onChange={(e) => onUpdate({ label: e.target.value })}
      />
      <div className="flex flex-wrap items-center gap-2">
        {loop && (
          <Badge tone="info" icon={<Repeat aria-hidden="true" className="size-3" />}>
            Loop
          </Badge>
        )}
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => onMove(-1)}
          aria-label="Check this handoff earlier"
        >
          <ArrowUp aria-hidden="true" className="size-4" /> Earlier
        </Button>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => onMove(1)}
          aria-label="Check this handoff later"
        >
          <ArrowDown aria-hidden="true" className="size-4" /> Later
        </Button>
        <Button variant="danger" size="sm" type="button" onClick={onRemove}>
          <Trash2 aria-hidden="true" className="size-4" /> Remove handoff
        </Button>
      </div>
    </li>
  );
}

export function StepEditor({
  def,
  step,
  index,
  workflows,
  playbooks,
  disabled,
  onStep,
  onMove,
  onRemove,
  onMakeFirst,
  onAddHandoff,
  onUpdateHandoff,
  onMoveHandoff,
  onRemoveHandoff,
}: {
  def: JourneyDefinition;
  step: JourneyStep;
  index: number;
  workflows: WorkflowOption[];
  playbooks: PlaybookOption[];
  disabled?: boolean;
  onStep: (patch: Record<string, unknown>) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  onMakeFirst: () => void;
  onAddHandoff: () => void;
  onUpdateHandoff: (id: string, patch: Partial<JourneyHandoff>) => void;
  onMoveHandoff: (id: string, d: -1 | 1) => void;
  onRemoveHandoff: (id: string) => void;
}) {
  const out = def.handoffs.filter((h) => h.from === step.id);
  return (
    <li className="rounded-card border border-line bg-surface p-4" data-testid={`step-${step.id}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand-soft-fg">
          {index + 1}
        </span>
        <Badge tone={step.kind === 'workflow' ? 'brand' : 'warning'}>
          {step.kind === 'workflow'
            ? 'Workflow'
            : step.kind === 'wait'
              ? 'Wait'
              : step.kind === 'gate'
                ? 'Approval gate'
                : 'Webhook call'}
        </Badge>
        {def.firstStepId === step.id && <Badge tone="success">Starts here</Badge>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput
          label="Step name"
          value={step.label}
          disabled={disabled}
          onChange={(e) => onStep({ label: e.target.value })}
        />
        {step.kind === 'workflow' && (
          <Select
            label="Workflow"
            value={step.workflowKey ?? ''}
            disabled={disabled}
            onChange={(e) => onStep({ workflowKey: e.target.value || null })}
          >
            <option value="">Pick a workflow…</option>
            {step.workflowKey && !workflows.some((w) => w.key === step.workflowKey) && (
              <option value={step.workflowKey}>{step.workflowKey} (not enabled in this project)</option>
            )}
            {workflows.map((w) => (
              <option key={w.key} value={w.key}>
                {w.name}
              </option>
            ))}
          </Select>
        )}
        {step.kind === 'workflow' && (
          <Select
            label="Playbook that helps in this step (optional)"
            value={step.playbook?.key ?? ''}
            disabled={disabled}
            onChange={(e) => {
              const p = playbooks.find((x) => x.key === e.target.value);
              onStep({ playbook: p ? { key: p.key, name: p.name } : undefined });
            }}
          >
            <option value="">None</option>
            {step.playbook && !playbooks.some((p) => p.key === step.playbook?.key) && (
              <option value={step.playbook.key}>{step.playbook.name || step.playbook.key}</option>
            )}
            {playbooks.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <StepSettings def={def} step={step} disabled={disabled} onStep={onStep} />
      {!disabled && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
          >
            <ArrowUp aria-hidden="true" className="size-4" /> Move up
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => onMove(1)}
            disabled={index === def.steps.length - 1}
          >
            <ArrowDown aria-hidden="true" className="size-4" /> Move down
          </Button>
          {def.firstStepId !== step.id && (
            <Button variant="secondary" size="sm" type="button" onClick={onMakeFirst}>
              Start here
            </Button>
          )}
          <Button variant="danger" size="sm" type="button" onClick={onRemove}>
            <Trash2 aria-hidden="true" className="size-4" /> Remove step
          </Button>
        </div>
      )}
      <div className="mt-4 border-t border-line pt-3">
        <h3 className="mb-2 text-sm font-semibold text-fg">What happens next</h3>
        {out.length === 0 ? (
          <p className="mb-2 text-sm text-muted">
            No handoff leaves this step: the journey ends when it does.
          </p>
        ) : (
          <ul className="mb-2 flex flex-col gap-2">
            {out.map((h) => (
              <HandoffRow
                key={h.id}
                def={def}
                h={h}
                onUpdate={(p) => onUpdateHandoff(h.id, p)}
                onMove={(d) => onMoveHandoff(h.id, d)}
                onRemove={() => onRemoveHandoff(h.id)}
              />
            ))}
          </ul>
        )}
        {!disabled && (
          <Button variant="secondary" size="sm" type="button" onClick={onAddHandoff}>
            <Plus aria-hidden="true" className="size-4" /> Add a handoff
          </Button>
        )}
      </div>
    </li>
  );
}
