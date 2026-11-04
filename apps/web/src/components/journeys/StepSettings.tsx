import type { JourneyDefinition, JourneyStep } from '@aom/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useForms } from '../../api/queries/forms.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import { DURATION_UNITS, durationError, timeoutOf, type TimeoutKind, type WaitKind, waitForOf } from '../../lib/journeys.ts';
import { Button, Select, TextArea, TextInput } from '../ui.tsx';

type Duration = { amount: number; unit: (typeof DURATION_UNITS)[number] };
type Timeout = { action: TimeoutKind; stepId?: string; maxReminders?: number; afterLast?: string; every?: Duration };

/** Amount and unit; the soft keyboard opens as a number pad. */
function DurationField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: Duration | undefined;
  disabled?: boolean | undefined;
  onChange: (d: Duration) => void;
}) {
  const err = durationError(value);
  return (
    <div className="grid grid-cols-2 gap-2">
      <TextInput
        label={label}
        type="text"
        inputMode="numeric"
        enterKeyHint="next"
        disabled={disabled}
        value={value ? String(value.amount) : ''}
        error={value && err ? err : undefined}
        onChange={(e) => onChange({ amount: Number(e.target.value.replace(/\D/g, '')) || 0, unit: value?.unit ?? 'days' })}
      />
      <Select
        label="Unit"
        disabled={disabled}
        value={value?.unit ?? 'days'}
        onChange={(e) => onChange({ amount: value?.amount ?? 1, unit: e.target.value as Duration['unit'] })}
      >
        {DURATION_UNITS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </Select>
    </div>
  );
}

function TimeoutEditor({
  def,
  stepId,
  value,
  disabled,
  onChange,
}: {
  def: JourneyDefinition;
  stepId: string;
  value: Timeout | undefined;
  disabled?: boolean | undefined;
  onChange: (t: Timeout) => void;
}) {
  const others = def.steps.filter((s) => s.id !== stepId);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Select
        label="When time runs out"
        disabled={disabled}
        value={value?.action ?? ''}
        onChange={(e) => onChange(timeoutOf(e.target.value as TimeoutKind, others[0]?.id) as Timeout)}
      >
        <option value="" disabled>
          Pick what happens…
        </option>
        <option value="remind">Send a reminder and keep waiting</option>
        <option value="goto">Move to another step</option>
        <option value="escalate">Ask the desk what to do</option>
        <option value="cancel">Cancel the journey</option>
      </Select>
      {value?.action === 'goto' && (
        <Select label="Step to move to" disabled={disabled} value={value.stepId ?? ''} onChange={(e) => onChange({ ...value, stepId: e.target.value })}>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
      )}
      {value?.action === 'remind' && (
        <>
          <TextInput
            label="Reminders before the desk is asked"
            inputMode="numeric"
            enterKeyHint="done"
            disabled={disabled}
            value={String(value.maxReminders ?? 3)}
            onChange={(e) => onChange({ ...value, maxReminders: Math.min(10, Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1)) })}
          />
          <Select
            label="After the last reminder"
            disabled={disabled}
            value={value.afterLast ?? 'escalate'}
            onChange={(e) => onChange({ ...value, afterLast: e.target.value })}
          >
            <option value="escalate">Ask the desk what to do</option>
            <option value="cancel">Cancel the journey</option>
          </Select>
        </>
      )}
    </div>
  );
}

/** Settings of the step kinds that wait, gate or call a webhook. Every change is a patch of the step. */
export function StepSettings({
  def,
  step,
  disabled,
  onStep,
}: {
  def: JourneyDefinition;
  step: JourneyStep;
  disabled?: boolean | undefined;
  onStep: (patch: Record<string, unknown>) => void;
}) {
  if (step.kind === 'wait') return <WaitSettings def={def} step={step} disabled={disabled} onStep={onStep} />;
  if (step.kind === 'gate') return <GateSettings def={def} step={step} disabled={disabled} onStep={onStep} />;
  if (step.kind === 'webhook_call') return <CallSettings step={step} disabled={disabled} onStep={onStep} />;
  return null;
}

function WaitSettings({
  def,
  step,
  disabled,
  onStep,
}: {
  def: JourneyDefinition;
  step: Extract<JourneyStep, { kind: 'wait' }>;
  disabled?: boolean | undefined;
  onStep: (p: Record<string, unknown>) => void;
}) {
  const forms = useForms('active');
  const w = step.waitFor as ({ kind: WaitKind } & Record<string, any>) | undefined;
  return (
    <div className="mt-3 flex flex-col gap-3" data-testid={`wait-settings-${step.id}`}>
      <Select
        label="Wait for"
        disabled={disabled}
        value={w?.kind ?? ''}
        onChange={(e) => onStep({ waitFor: waitForOf(e.target.value as WaitKind) })}
      >
        <option value="" disabled>
          Pick what to wait for…
        </option>
        <option value="duration">A length of time</option>
        <option value="date">A date on the record</option>
        <option value="form">A form from the client</option>
        <option value="webhook">A webhook call</option>
      </Select>
      {w?.kind === 'date' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label="Date field of the last finished card"
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="next"
            disabled={disabled}
            value={w.dateFrom?.field ?? ''}
            onChange={(e) => onStep({ waitFor: { ...w, dateFrom: { field: e.target.value } } })}
          />
          <TextInput
            label="Time of day (24 hours)"
            inputMode="numeric"
            enterKeyHint="next"
            disabled={disabled}
            value={w.atTime ?? '09:00'}
            onChange={(e) => onStep({ waitFor: { ...w, atTime: e.target.value } })}
          />
          <DurationField
            label="Shift by (optional)"
            value={w.offset}
            disabled={disabled}
            onChange={(d) => onStep({ waitFor: { ...w, offset: d } })}
          />
        </div>
      )}
      {w?.kind === 'form' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Form to send"
            disabled={disabled}
            value={w.formId ?? ''}
            onChange={(e) => onStep({ waitFor: { ...w, formId: e.target.value || null } })}
          >
            <option value="">Pick a form…</option>
            {(forms.data ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.title}
              </option>
            ))}
          </Select>
          <Select
            label="What the client sends"
            disabled={disabled}
            value={w.purpose ?? 'answers'}
            onChange={(e) => onStep({ waitFor: { ...w, purpose: e.target.value } })}
          >
            <option value="answers">Answers</option>
            <option value="upload">Documents</option>
          </Select>
          <Select
            label="Who passes the link on"
            disabled={disabled}
            value={w.send?.via ?? 'desk'}
            onChange={(e) => onStep({ waitFor: { ...w, send: { via: e.target.value } } })}
          >
            <option value="desk">A person on the desk</option>
            <option value="webhook">A webhook (your own system)</option>
          </Select>
        </div>
      )}
      {w?.kind === 'webhook' && (
        <p className="text-sm text-muted">
          The wait ends when a hook of this journey that resumes it is called. Add the hook under "Webhooks" below the steps.
        </p>
      )}
      <DurationField label="Wait at most" value={step.duration} disabled={disabled} onChange={(d) => onStep({ duration: d })} />
      <TimeoutEditor
        def={def}
        stepId={step.id}
        value={step.onTimeout as Timeout | undefined}
        disabled={disabled}
        onChange={(t) => onStep({ onTimeout: t })}
      />
    </div>
  );
}

function GateSettings({
  def,
  step,
  disabled,
  onStep,
}: {
  def: JourneyDefinition;
  step: Extract<JourneyStep, { kind: 'gate' }>;
  disabled?: boolean | undefined;
  onStep: (p: Record<string, unknown>) => void;
}) {
  const a = step.approver as { kind: string; role?: string } | undefined;
  const value = !a ? '' : a.kind === 'org_role' ? `role:${a.role}` : a.kind;
  const dl = step.deadline as { duration: Duration; onTimeout: Timeout } | undefined;
  return (
    <div className="mt-3 flex flex-col gap-3" data-testid={`gate-settings-${step.id}`}>
      <Select
        label="Who decides"
        disabled={disabled}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          onStep({ approver: v.startsWith('role:') ? { kind: 'org_role', role: v.slice(5) } : { kind: v } });
        }}
      >
        <option value="" disabled>
          Pick who approves…
        </option>
        <option value="project_owner">The project owner</option>
        <option value="org_owner">The organization owner</option>
        <option value="role:admin">An organization admin</option>
        <option value="role:owner">An organization owner</option>
      </Select>
      <TextArea
        label="Question for the approver (optional)"
        rows={2}
        disabled={disabled}
        value={step.question ?? ''}
        onChange={(e) => onStep({ question: e.target.value || undefined })}
      />
      <p className="text-sm text-muted">
        Approve follows the handoff "approved" (or "done"); reject follows the handoff "rejected". Add both under "What happens next".
      </p>
      {dl ? (
        <>
          <DurationField
            label="Decide within"
            value={dl.duration}
            disabled={disabled}
            onChange={(d) => onStep({ deadline: { ...dl, duration: d } })}
          />
          <TimeoutEditor def={def} stepId={step.id} value={dl.onTimeout} disabled={disabled} onChange={(t) => onStep({ deadline: { ...dl, onTimeout: t } })} />
          {!disabled && (
            <div>
              <Button variant="secondary" size="sm" type="button" onClick={() => onStep({ deadline: undefined })}>
                No deadline
              </Button>
            </div>
          )}
        </>
      ) : (
        !disabled && (
          <div>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => onStep({ deadline: { duration: { amount: 2, unit: 'days' }, onTimeout: timeoutOf('remind') } })}
            >
              Add a deadline
            </Button>
          </div>
        )
      )}
    </div>
  );
}

function CallSettings({
  step,
  disabled,
  onStep,
}: {
  step: Extract<JourneyStep, { kind: 'webhook_call' }>;
  disabled?: boolean | undefined;
  onStep: (p: Record<string, unknown>) => void;
}) {
  const ws = useWorkstations();
  const list = (ws.data ?? []) as Array<{ id: string; name: string }>;
  const headers = step.headers ?? [];
  const setHeader = (i: number, patch: Record<string, string>) =>
    onStep({ headers: headers.map((h, k) => (k === i ? { ...h, ...patch } : h)) });
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2" data-testid={`call-settings-${step.id}`}>
      <Select
        label="Computer that sends the call"
        disabled={disabled}
        value={step.workstationId ?? ''}
        onChange={(e) => onStep({ workstationId: e.target.value || null })}
      >
        <option value="">Pick a computer…</option>
        {list.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </Select>
      <Select label="Method" disabled={disabled} value={step.method} onChange={(e) => onStep({ method: e.target.value })}>
        {['POST', 'PUT', 'PATCH', 'GET', 'DELETE'].map((m) => (
          <option key={m}>{m}</option>
        ))}
      </Select>
      <div className="sm:col-span-2">
        <TextInput
          label="URL"
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          enterKeyHint="next"
          disabled={disabled}
          value={step.url}
          onChange={(e) => onStep({ url: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <span className="text-sm font-medium text-fg">Headers</span>
        {headers.map((h, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <TextInput label="Name" autoCapitalize="none" disabled={disabled} value={h.name} onChange={(e) => setHeader(i, { name: e.target.value })} />
            <TextInput label="Value" autoCapitalize="none" disabled={disabled} value={h.value} onChange={(e) => setHeader(i, { value: e.target.value })} />
            {!disabled && (
              <Button variant="danger" size="sm" type="button" aria-label="Remove header" onClick={() => onStep({ headers: headers.filter((_, k) => k !== i) })}>
                <Trash2 aria-hidden="true" className="size-4" />
              </Button>
            )}
          </div>
        ))}
        {!disabled && (
          <div>
            <Button variant="secondary" size="sm" type="button" onClick={() => onStep({ headers: [...headers, { name: '', value: '' }] })}>
              <Plus aria-hidden="true" className="size-4" /> Add a header
            </Button>
          </div>
        )}
        <p className="text-sm text-muted">
          Secrets (tokens, a signing key) are not typed here: they are kept on the sending computer and only named on this step.
        </p>
      </div>
      <TextInput
        label="Name of the signing secret (optional)"
        autoCapitalize="none"
        autoCorrect="off"
        disabled={disabled}
        value={step.signWith ?? ''}
        onChange={(e) => onStep({ signWith: e.target.value || undefined })}
      />
      <Select label="Content type" disabled={disabled} value={step.contentType} onChange={(e) => onStep({ contentType: e.target.value })}>
        <option value="application/json">JSON</option>
        <option value="application/x-www-form-urlencoded">Form fields</option>
        <option value="text/plain">Plain text</option>
      </Select>
      <div className="sm:col-span-2">
        <TextArea
          label="Body (fill in with tokens such as {record.name})"
          rows={4}
          autoCapitalize="none"
          disabled={disabled}
          value={step.body}
          onChange={(e) => onStep({ body: e.target.value })}
        />
      </div>
    </div>
  );
}
