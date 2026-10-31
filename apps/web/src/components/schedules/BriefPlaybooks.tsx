import type { BriefPlaybookDto, ScheduleDto } from '@aom/shared';
import { BUSINESS_ROLES } from '@aom/shared';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { useMe } from '../../api/queries/auth.ts';
import { useBriefPlaybooks } from '../../api/queries/briefPlaybooks.ts';
import { useDeleteSchedule, useRunSchedule, useTestSchedule } from '../../api/queries/schedules.ts';
import { useBusinessMode } from '../../lib/orgMode.ts';
import { describeTrigger } from '../../lib/schedules.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Button, ConfirmDialog, Panel, useToast } from '../ui.tsx';
import { BriefPlaybookDialog } from './BriefPlaybookDialog.tsx';

const roleName = (key: string) => BUSINESS_ROLES.find((r) => r.key === key)?.name ?? key;

/**
 * Ready-made Brief playbooks (Morning plan, Weekly owner brief) at the top of Automations: a business organization's
 * Owner and Admins install one with their destinations, edit it, run it now, send a test or remove it.
 */
export function BriefPlaybooks({
  schedules,
  onSecret,
}: {
  schedules: ScheduleDto[];
  onSecret: (v: { name: string; value: string }) => void;
}) {
  const business = useBusinessMode();
  const role = useMe().data?.activeOrg?.role;
  const manager = role === 'owner' || role === 'admin';
  const show = business && manager;
  const list = useBriefPlaybooks(show);
  const [open, setOpen] = useState<BriefPlaybookDto | null>(null);
  if (!show || !list.data) return null;
  const installed = (p: BriefPlaybookDto) => schedules.find((s) => s.id === p.scheduleId);
  return (
    <section aria-label="Playbooks" className="flex flex-col gap-3" data-testid="brief-playbooks">
      <h2 className="text-sm font-semibold tracking-wide text-subtle uppercase">Playbooks</h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {list.data.map((p) => (
          <li key={p.key}>
            <PlaybookTile playbook={p} schedule={installed(p)} onOpen={() => setOpen(p)} />
          </li>
        ))}
      </ul>
      {open && (
        <BriefPlaybookDialog
          playbook={open}
          schedule={installed(open)}
          onClose={() => setOpen(null)}
          onSecret={onSecret}
        />
      )}
    </section>
  );
}

function PlaybookTile({
  playbook: p,
  schedule: s,
  onOpen,
}: {
  playbook: BriefPlaybookDto;
  schedule: ScheduleDto | undefined;
  onOpen: () => void;
}) {
  const run = useRunSchedule();
  const test = useTestSchedule();
  const del = useDeleteSchedule();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const destinations = s?.action.kind === 'create_card' ? (s.action.deliverOutput?.destinations ?? []) : [];
  return (
    <Panel data-testid={`playbook-${p.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        <FileText aria-hidden="true" className="size-4 text-subtle" />
        <h3 className="text-lg font-semibold text-fg">{p.name}</h3>
        {s ? <Badge tone="green">Installed</Badge> : <Badge>Not installed</Badge>}
      </div>
      <p className="mt-1 text-sm text-muted">{p.description}</p>
      {s ? (
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm text-fg">
          <div>
            <dt className="text-xs text-subtle">When</dt>
            <dd data-testid="playbook-when">{describeTrigger(s.trigger)}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Next run</dt>
            <dd>{s.nextFireAt ? formatDateTime(s.nextFireAt) : 'not scheduled'}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Goes to</dt>
            <dd>{destinations.map((d) => d.kind.replace('_', ' ')).join(', ') || 'nowhere yet'}</dd>
          </div>
        </dl>
      ) : (
        <p className="mt-2 text-sm text-subtle">
          Written by the {roleName(p.defaultOwnerRole)}, at most {p.maxWords} words.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {s ? (
          <>
            <Button className="min-h-11" onClick={onOpen} data-testid="playbook-edit">
              Edit
            </Button>
            <Button
              className="min-h-11"
              loading={run.isPending}
              onClick={() =>
                run.mutate(s.id, { onSuccess: (r) => toast.success(r.ref ? `Emitted ${r.ref}` : 'Started') })
              }
            >
              Run now
            </Button>
            <Button className="min-h-11" loading={test.isPending} onClick={() => test.mutate(s.id)}>
              Send test
            </Button>
            <Button className="min-h-11" onClick={() => setConfirming(true)} data-testid="playbook-remove">
              Remove
            </Button>
          </>
        ) : (
          <Button variant="primary" className="min-h-11" onClick={onOpen} data-testid="playbook-install">
            Install
          </Button>
        )}
      </div>
      {s && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Remove ${p.name}?`}
          description="The next run will not happen and nothing more is sent. Briefs already written stay on their cards."
          confirmLabel="Remove"
          onConfirm={() => del.mutate(s.id, { onSettled: () => setConfirming(false) })}
        />
      )}
    </Panel>
  );
}
