import { OUTPUT_DESTINATION_KINDS, WEBHOOK_FORMATS } from '@aom/shared';
import { Plus, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { useWorkstationIntegrations } from '../../api/queries/integrations.ts';
import { emptyOutput, type OutputDraft, WEBHOOK_FORMAT_LABEL } from '../../lib/schedules.ts';
import { Button, Select, TextInput } from '../ui.tsx';

const KIND_LABEL: Record<OutputDraft['kind'], string> = {
  email: 'E-mail',
  webhook: 'Webhook',
  whatsapp: 'WhatsApp',
  google_sheet: 'Google Sheet',
};
const MAX_DESTINATIONS = 5;

/** The connected accounts of one workstation for WhatsApp or Google Sheets, and a link to connect one. */
function ConnectionPicker({
  d,
  set,
  workstations,
}: {
  d: OutputDraft;
  set: (p: Partial<OutputDraft>) => void;
  workstations: Array<{ id: string; name: string }>;
}) {
  const kind = d.kind === 'whatsapp' ? 'whatsapp' : 'google-sheets';
  const data = useWorkstationIntegrations(d.workstationId || undefined);
  const connected = (data.data?.integrations ?? []).filter((i) => i.kind === kind && i.state === 'connected');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Select
        label="Workstation"
        value={d.workstationId}
        onChange={(e) => set({ workstationId: e.target.value, instance: '' })}
        hint="The message is sent from this machine, with the account you connected there."
      >
        <option value="">Choose a workstation</option>
        {workstations.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </Select>
      <Select
        label={d.kind === 'whatsapp' ? 'WhatsApp number' : 'Service account'}
        value={d.instance}
        disabled={!d.workstationId}
        onChange={(e) => set({ instance: e.target.value })}
        hint={
          d.workstationId && connected.length === 0 && !data.isLoading
            ? `Nothing connected on this workstation yet. Connect ${d.kind === 'whatsapp' ? 'WhatsApp' : 'Google Sheets'} on its Integrations page; the key is typed there, never here.`
            : undefined
        }
      >
        <option value="">Choose</option>
        {connected.map((i) => (
          <option key={i.instance} value={i.instance}>
            {i.account ? `${i.account} (${i.instance})` : i.instance}
          </option>
        ))}
      </Select>
      {d.workstationId && connected.length === 0 && !data.isLoading && (
        <Link className="text-sm text-accent underline sm:col-span-2" to="/integrations">
          Open the Integrations page
        </Link>
      )}
    </div>
  );
}

function OutputRow({
  d,
  index,
  set,
  remove,
  error,
  workstations,
}: {
  d: OutputDraft;
  index: number;
  set: (p: Partial<OutputDraft>) => void;
  remove: () => void;
  error: string | undefined;
  workstations: Array<{ id: string; name: string }>;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-panel border border-line p-3" data-testid={`output-${index}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Select
            label="Send it to"
            value={d.kind}
            onChange={(e) => set({ ...emptyOutput(e.target.value as OutputDraft['kind']) })}
          >
            {OUTPUT_DESTINATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </div>
        <Button
          type="button"
          variant="secondary"
          className="min-h-11 min-w-11"
          aria-label={`Remove destination ${index + 1}`}
          onClick={remove}
        >
          <Trash2 size={16} aria-hidden="true" />
        </Button>
      </div>
      {d.kind === 'email' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label="To"
            type="email"
            inputMode="email"
            autoComplete="email"
            multiple
            value={d.to}
            onChange={(e) => set({ to: e.target.value })}
            hint="Separate several addresses with commas."
          />
          <TextInput
            label="Subject (optional)"
            value={d.subject}
            onChange={(e) => set({ subject: e.target.value })}
            hint="{ref} and {title} are filled in."
          />
        </div>
      )}
      {d.kind === 'webhook' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label="URL"
            type="url"
            inputMode="url"
            value={d.url}
            onChange={(e) => set({ url: e.target.value })}
            hint="Signed like every webhook; the signing secret is shown once after you save."
          />
          <Select
            label="Format"
            value={d.format}
            onChange={(e) => set({ format: e.target.value as OutputDraft['format'] })}
          >
            {WEBHOOK_FORMATS.map((f) => (
              <option key={f} value={f}>
                {WEBHOOK_FORMAT_LABEL[f]}
              </option>
            ))}
          </Select>
        </div>
      )}
      {d.kind === 'whatsapp' && (
        <>
          <ConnectionPicker d={d} set={set} workstations={workstations} />
          <TextInput
            label="To numbers"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={d.numbers}
            onChange={(e) => set({ numbers: e.target.value })}
            hint="With the country code, like +27821234567. Separate several with commas."
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput
              label="Template name (optional)"
              value={d.templateName}
              onChange={(e) => set({ templateName: e.target.value })}
              hint="WhatsApp only lets a business start a chat with an approved template. Without one, the message works only within 24 hours of the person's last message to you."
            />
            <TextInput
              label="Template language"
              value={d.templateLanguage}
              onChange={(e) => set({ templateLanguage: e.target.value })}
            />
          </div>
        </>
      )}
      {d.kind === 'google_sheet' && (
        <>
          <ConnectionPicker d={d} set={set} workstations={workstations} />
          {d.instance && (
            <p className="text-sm text-muted">
              Share the sheet with <strong className="break-all">{d.instance}</strong> as Editor.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput
              label="Sheet address"
              type="url"
              inputMode="url"
              value={d.sheet}
              onChange={(e) => set({ sheet: e.target.value })}
              hint="Paste the address of the sheet. One row is added each time: time, automation, card, title, result and link."
            />
            <TextInput label="Tab" value={d.tab} onChange={(e) => set({ tab: e.target.value })} />
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** "Send the result when the card is done": up to five destinations. No secret is typed here. */
export function OutputSection({
  outputs,
  onChange,
  errors,
  workstations,
}: {
  outputs: OutputDraft[];
  onChange: (o: OutputDraft[]) => void;
  errors: Record<string, string>;
  workstations: Array<{ id: string; name: string }>;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-panel border border-line p-3" data-testid="output-section">
      <div>
        <h3 className="text-sm font-semibold">Send the result when the card is done</h3>
        <p className="text-xs text-subtle">
          The agent's last note and a link to the card go where you choose. Off unless you add a destination.
        </p>
      </div>
      {outputs.map((d, i) => (
        <OutputRow
          // biome-ignore lint/suspicious/noArrayIndexKey: drafts have no id; rows are only added at the end or removed
          key={i}
          d={d}
          index={i}
          error={errors[`output.${i}`]}
          workstations={workstations}
          set={(p) => onChange(outputs.map((x, j) => (j === i ? { ...x, ...p } : x)))}
          remove={() => onChange(outputs.filter((_, j) => j !== i))}
        />
      ))}
      {outputs.length < MAX_DESTINATIONS && (
        <div>
          <Button
            type="button"
            variant="secondary"
            className="min-h-11"
            onClick={() => onChange([...outputs, emptyOutput()])}
          >
            <Plus size={16} aria-hidden="true" /> Add a destination
          </Button>
        </div>
      )}
    </div>
  );
}
