import type { CloudWorkstation, OfficeHours } from '@aom/shared';
import { Cloud, Moon, Power } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import {
  useCloudWorkstations,
  usePatchCloud,
  useRemoveCloud,
  useStopCloud,
  useWakeCloud,
} from '../../api/queries/cloud.ts';
import { Badge, Button, Callout, ConfirmDialog, Dialog, Panel, Select, TextInput, useToast } from '../ui.tsx';

const STATE_LABEL: Record<
  CloudWorkstation['state'],
  { text: string; tone: 'success' | 'neutral' | 'warning' | 'danger' | 'info' }
> = {
  installing: { text: 'Installing', tone: 'info' },
  running: { text: 'Running', tone: 'success' },
  stopped: { text: 'Asleep', tone: 'neutral' },
  starting: { text: 'Waking up', tone: 'info' },
  stopping: { text: 'Stopping', tone: 'neutral' },
  failed: { text: 'Failed', tone: 'danger' },
  needs_attention: { text: 'Needs attention', tone: 'warning' },
};

const money = (n: number) => `$${n.toFixed(2)}`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The cloud workstations of the organization: status, wake and stop, the monthly estimate, idle time and office hours. */
export function CloudWorkstations({ canManage }: { canManage: boolean }) {
  const q = useCloudWorkstations();
  const list = q.data?.cloudWorkstations ?? [];
  if (q.isError || list.length === 0) return null;
  const onlyCodespaces = list.every((c) => c.provider === 'codespaces');
  return (
    <section aria-labelledby="cloud-heading" className="mb-6" data-testid="cloud-workstations">
      <h2 id="cloud-heading" className="mb-2 flex items-center gap-2 text-lg font-semibold text-fg">
        <Cloud aria-hidden="true" className="size-5 text-muted" /> Cloud workstations
      </h2>
      {onlyCodespaces && q.data && !q.data.hasDockerCapableWorkstation && (
        <Callout
          tone="warning"
          className="mb-3"
          data-testid="docker-notice"
          title="Codespaces cannot deploy Docker images"
        >
          A Codespace cannot run Docker, so deploying Docker images needs a workstation of yours or a VPS. Add
          one (choose <strong>My computer</strong> or <strong>A VPS</strong> in "Add a workstation") and point
          your deploy targets at it.
        </Callout>
      )}
      <ul className="flex flex-col gap-3">
        {list.map((c) => (
          <CloudCard key={c.id} c={c} canManage={canManage} />
        ))}
      </ul>
    </section>
  );
}

function CloudCard({ c, canManage }: { c: CloudWorkstation; canManage: boolean }) {
  const toast = useToast();
  const wake = useWakeCloud();
  const stop = useStopCloud();
  const remove = useRemoveCloud();
  const [confirm, setConfirm] = useState(false);
  const [edit, setEdit] = useState(false);
  const s = STATE_LABEL[c.state];
  const busy = wake.isPending || stop.isPending;
  const act = (m: typeof wake | typeof stop, label: string) =>
    m.mutate(c.id, {
      onSuccess: () => toast.success(label),
      onError: (e) => toast.error(errorMessage(e)),
    });
  return (
    <li data-testid={`cloud-${c.name}`}>
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-lg font-semibold text-fg">{c.name}</p>
            <p className="text-sm text-muted">
              {c.provider === 'ssh' ? 'VPS over SSH' : 'GitHub Codespace'} · {c.location}
            </p>
          </div>
          <Badge tone={s.tone} data-testid="cloud-state">
            {s.text}
          </Badge>
        </div>
        {c.stateDetail && (
          <p
            className={`mt-2 text-sm ${c.state === 'failed' || c.state === 'needs_attention' ? 'text-danger' : 'text-muted'}`}
          >
            {c.stateDetail}
          </p>
        )}
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-muted">Estimated cost</dt>
            <dd className="font-medium text-fg" data-testid="cloud-estimate" title={c.estimateBasis}>
              {c.provider === 'ssh' && c.monthlyEstimateUsd === 0
                ? 'not set'
                : `${money(c.monthlyEstimateUsd)} a month`}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted">Stops after</dt>
            <dd className="text-fg">
              {c.provider === 'ssh' ? 'always on' : `${c.idleMinutes} minutes without work`}
            </dd>
          </div>
          {c.provider === 'codespaces' && (
            <div className="flex gap-2">
              <dt className="text-muted">Office hours</dt>
              <dd className="text-fg">
                {c.officeHours
                  ? `${c.officeHours.days.map((d) => DAYS[d]).join(', ')} ${c.officeHours.from} to ${c.officeHours.to} (${c.officeHours.timezone})`
                  : 'any time'}
              </dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="text-muted">Claude sign-in</dt>
            <dd className="text-fg">
              {c.authMode === 'api_key' ? 'your API key' : 'your subscription (individual use)'}
            </dd>
          </div>
        </dl>
        <p className="mt-1 text-xs text-subtle">
          {c.estimateBasis} Guildwise does not charge for this machine.
        </p>
        {c.authMode === 'subscription' && (
          <Callout tone="warning" className="mt-3" title="Individual use only">
            A Claude subscription is meant for one person's own use. Many agents working in parallel can hit
            its limits, and Anthropic's terms apply. An API key is the better fit for a shared cloud
            workstation.
          </Callout>
        )}
        {c.provider === 'ssh' && c.state === 'running' && (
          <p className="mt-2 text-sm text-muted" data-testid="vps-next-step">
            Last step: sign in to Claude on the server. Connect with SSH and run{' '}
            <code className="rounded bg-sunken px-1">
              {c.authMode === 'api_key' ? 'read -rs K; printf %s "$K" | aom-runner auth api-key' : 'claude'}
            </code>
            . Guildwise never sees it. A VPS is always on; start and stop it at your VPS company.
          </p>
        )}
        {canManage && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {c.provider === 'codespaces' && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || c.state === 'running' || c.state === 'starting'}
                  onClick={() => act(wake, 'Waking the codespace')}
                >
                  <Power aria-hidden="true" className="mr-1 size-4" /> Wake
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || c.state !== 'running'}
                  onClick={() => act(stop, 'Stopped')}
                >
                  <Moon aria-hidden="true" className="mr-1 size-4" /> Stop
                </Button>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={() => setEdit(true)}>
              Settings
            </Button>
            <Button variant="danger-ghost" size="sm" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          </div>
        )}
      </Panel>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${c.name}?`}
        description={
          c.provider === 'ssh'
            ? 'Guildwise forgets it and unpairs the runner. The server itself keeps running (and costing money) until you cancel it at your VPS company.'
            : 'Guildwise stops and forgets it and unpairs the runner. Delete the codespace on GitHub too if you no longer want to pay for its disk.'
        }
        confirmLabel="Remove"
        onConfirm={() =>
          remove.mutate(c.id, {
            onSuccess: () => setConfirm(false),
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
      {edit && <CloudSettings c={c} onClose={() => setEdit(false)} />}
    </li>
  );
}

function CloudSettings({ c, onClose }: { c: CloudWorkstation; onClose: () => void }) {
  const patch = usePatchCloud();
  const toast = useToast();
  const [idle, setIdle] = useState(String(c.idleMinutes));
  const [price, setPrice] = useState(
    c.provider === 'ssh' && c.monthlyEstimateUsd ? String(c.monthlyEstimateUsd) : '',
  );
  const [useHours, setUseHours] = useState(!!c.officeHours);
  const [days, setDays] = useState<number[]>(c.officeHours?.days ?? [1, 2, 3, 4, 5]);
  const [from, setFrom] = useState(c.officeHours?.from ?? '08:00');
  const [to, setTo] = useState(c.officeHours?.to ?? '17:00');
  const [tz, setTz] = useState(c.officeHours?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const save = () => {
    const officeHours: OfficeHours | null =
      useHours && days.length > 0 ? { days, from, to, timezone: tz } : null;
    patch.mutate(
      {
        id: c.id,
        patch:
          c.provider === 'ssh'
            ? { monthlyPriceUsd: price === '' ? null : Number(price) }
            : { idleMinutes: Number(idle), officeHours },
      },
      { onSuccess: () => (toast.success('Saved'), onClose()), onError: (e) => toast.error(errorMessage(e)) },
    );
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="md" title={`Settings for ${c.name}`}>
      <div className="flex flex-col gap-4">
        {c.provider === 'ssh' ? (
          <TextInput
            label="What the VPS costs a month (US dollars)"
            type="number"
            min={0}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            hint="Only for the estimate on this page. You pay your VPS company directly."
          />
        ) : (
          <>
            <Select
              label="Stop after this many idle minutes"
              value={idle}
              onChange={(e) => setIdle(e.target.value)}
            >
              {[15, 30, 60, 120].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={useHours} onChange={(e) => setUseHours(e.target.checked)} />
              Only wake it during office hours
            </label>
            {useHours && (
              <fieldset className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2" role="group" aria-label="Days">
                  {DAYS.map((d, i) => (
                    <label key={d} className="flex items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        checked={days.includes(i)}
                        onChange={(e) =>
                          setDays(e.target.checked ? [...days, i] : days.filter((x) => x !== i))
                        }
                      />
                      {d}
                    </label>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <TextInput
                    label="From"
                    type="time"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                  <TextInput label="To" type="time" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
                <TextInput label="Time zone" value={tz} onChange={(e) => setTz(e.target.value)} />
              </fieldset>
            )}
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={patch.isPending}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
