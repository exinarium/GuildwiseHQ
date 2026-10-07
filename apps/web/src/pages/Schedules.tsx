import {
  type CreateScheduleResponse,
  isWebhookAction,
  type ScheduleDto,
  type SystemScheduleDto,
} from '@aom/shared';
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  History,
  KeyRound,
  Lock,
  Pause,
  Pencil,
  Play,
  Plus,
  Send,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  useDeleteSchedule,
  usePatchSchedule,
  useRotateSecret,
  useRunSchedule,
  useScheduleList,
  useTestSchedule,
} from '../api/queries/schedules.ts';
import { RunHistory } from '../components/schedules/RunHistory.tsx';
import { ScheduleWizard } from '../components/schedules/ScheduleWizard.tsx';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  useToast,
} from '../components/ui.tsx';
import { actionLabel, describeAction, describeTrigger } from '../lib/schedules.ts';
import { formatDateTime } from '../lib/time.ts';

/**
 * Schedules: a trigger (a time, an event, a labelled issue or nothing) and one action (a card, a regression, a DevOps
 * request, a BA task, an integration). Runs, history and the webhook delivery log are on each schedule; the jobs the
 * system runs by itself are listed read-only at the end.
 */
export function Schedules() {
  const list = useScheduleList();
  const [wizard, setWizard] = useState<{ open: boolean; editing?: ScheduleDto }>({ open: false });
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const schedules = list.data?.schedules ?? [];
  const system = list.data?.system ?? [];

  const groups = new Map<string, ScheduleDto[]>();
  for (const s of schedules) {
    const key = s.projectKey ? `${s.projectKey} ${s.projectName ?? ''}`.trim() : 'Whole organization';
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === 'Whole organization' ? -1 : b === 'Whole organization' ? 1 : a.localeCompare(b),
  );
  const onCreated = (c: CreateScheduleResponse) => {
    if (c.webhookSecret) setSecret({ name: c.name, value: c.webhookSecret });
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader
        title="Schedules"
        sub="Run something on a time, when an event happens, or when an issue gets a label. No agent ever polls: the server does."
        actions={
          <Button variant="primary" data-testid="new-schedule" onClick={() => setWizard({ open: true })}>
            <Plus aria-hidden="true" className="size-4" />
            New schedule
          </Button>
        }
      />
      {secret && <SecretNotice name={secret.name} value={secret.value} onClose={() => setSecret(null)} />}
      {list.isPending && <ListSkeleton label="Loading schedules" rows={2} />}
      <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      {ordered.map(([group, items]) => (
        <section key={group} aria-label={group} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold tracking-wide text-subtle uppercase">{group}</h2>
          <ul className="flex flex-col gap-3" aria-label={`Schedules of ${group}`} data-testid="schedules">
            {items.map((s) => (
              <li key={s.id} data-testid={`schedule-${s.name}`}>
                <ScheduleRow
                  schedule={s}
                  onEdit={() => setWizard({ open: true, editing: s })}
                  onSecret={setSecret}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {list.data && schedules.length === 0 && (
        <EmptyState
          data-testid="schedules-empty"
          icon={CalendarClock}
          title="No schedules yet"
          description="A schedule runs something for you: a weekly regression, a card when a phase is completed, a Slack message when a card is finalized, a morning e-mail digest, or new GitHub issues taken into intake."
          action={
            <Button variant="primary" onClick={() => setWizard({ open: true })}>
              Create the first schedule
            </Button>
          }
        />
      )}
      {system.length > 0 && (
        <section aria-label="Run by the system" className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold tracking-wide text-subtle uppercase">Run by the system</h2>
          <ul className="flex flex-col gap-3" aria-label="System jobs" data-testid="system-schedules">
            {system.map((s) => (
              <li key={s.id}>
                <SystemRow row={s} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <ScheduleWizard
        open={wizard.open}
        onOpenChange={(open) => setWizard((cur) => ({ ...cur, open }))}
        editing={wizard.editing}
        onCreated={onCreated}
      />
    </div>
  );
}

function SecretNotice({ name, value, onClose }: { name: string; value: string; onClose: () => void }) {
  return (
    <Callout tone="info" data-testid="webhook-secret">
      <p className="font-medium">Signing secret of "{name}"</p>
      <p className="mt-1 text-sm">
        Copy it now: it is shown only this once. Your receiver checks the <code>X-AOM-Signature</code> header
        against it.
      </p>
      <p
        className="mt-2 rounded-control bg-sunken px-2 py-1.5 font-mono text-sm break-all text-fg"
        data-testid="secret-value"
      >
        {value}
      </p>
      <div className="mt-2 flex gap-2">
        <Button onClick={() => void navigator.clipboard?.writeText(value)}>Copy</Button>
        <Button onClick={onClose}>I have saved it</Button>
      </div>
    </Callout>
  );
}

function SystemRow({ row }: { row: SystemScheduleDto }) {
  return (
    <Panel data-testid={`system-${row.kind}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Lock aria-hidden="true" className="size-4 text-subtle" />
        <h3 className="text-lg font-semibold text-fg">{row.name}</h3>
        <Badge>System</Badge>
        <Link to={row.configureAt} className="ml-auto text-sm text-brand-text underline">
          Configure
        </Link>
      </div>
      <p className="mt-1 text-sm text-muted">{row.description}</p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm text-fg sm:grid-cols-3">
        <div>
          <dt className="text-xs text-subtle">When</dt>
          <dd>{row.when}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Next run</dt>
          <dd>{row.nextRunAt ? formatDateTime(row.nextRunAt) : 'not scheduled'}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Last run</dt>
          <dd>{row.lastRunAt ? formatDateTime(row.lastRunAt) : 'never'}</dd>
        </div>
      </dl>
    </Panel>
  );
}

const STATUS_TONE = { ok: 'success', failed: 'danger', pending: 'warning' } as const;
const STATUS_LABEL = { ok: 'Last run done', failed: 'Last run failed', pending: 'Last run waiting' } as const;

function ScheduleRow({
  schedule: s,
  onEdit,
  onSecret,
}: {
  schedule: ScheduleDto;
  onEdit: () => void;
  onSecret: (v: { name: string; value: string }) => void;
}) {
  const patch = usePatchSchedule();
  const run = useRunSchedule();
  const del = useDeleteSchedule();
  const test = useTestSchedule();
  const rotate = useRotateSecret();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [history, setHistory] = useState(false);
  const webhook = isWebhookAction(s.action);
  const testable = webhook || (s.action.kind === 'integration' && s.action.integration === 'email');
  const managed = !!s.interestId;
  const editable = s.canEdit !== false && !managed;
  const Chevron = history ? ChevronDown : ChevronRight;

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold text-fg [overflow-wrap:anywhere]">{s.name}</h3>
        <Badge tone="brand">{actionLabel(s.action)}</Badge>
        <Badge tone={s.enabled ? 'green' : 'amber'}>{s.enabled ? 'Enabled' : 'Paused'}</Badge>
        {s.orgLevel && (
          <Badge title="Acts for the whole organization: only Owners and Admins change it">
            Organization
          </Badge>
        )}
        {s.lastStatus && <Badge tone={STATUS_TONE[s.lastStatus]}>{STATUS_LABEL[s.lastStatus]}</Badge>}
        {(s.failCount ?? 0) > 0 && (
          <Badge tone="red" title={s.lastError ?? undefined}>
            Cannot run ({s.failCount} failed {s.failCount === 1 ? 'try' : 'tries'})
          </Badge>
        )}
      </div>
      {(s.failCount ?? 0) > 0 && s.lastError && (
        <p className="mt-1 text-sm text-danger" data-testid="schedule-error">
          {s.lastError} Retrying with growing pauses.
        </p>
      )}
      <p className="mt-1 text-sm text-muted [overflow-wrap:anywhere]" data-testid="schedule-action">
        {describeAction(s.action)}
      </p>
      <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm text-fg sm:grid-cols-2">
        <div>
          <dt className="text-xs text-subtle">When</dt>
          <dd data-testid="schedule-when">{describeTrigger(s.trigger)}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Next run</dt>
          <dd data-testid="schedule-next">
            {s.nextFireAt
              ? formatDateTime(s.nextFireAt)
              : s.trigger.kind === 'event'
                ? 'on the event'
                : 'not scheduled'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Last run</dt>
          <dd data-testid="schedule-last">
            {s.lastFiredAt ? formatDateTime(s.lastFiredAt) : 'never'}
            {s.lastSummary ? <span className="text-muted"> - {s.lastSummary}</span> : null}
          </dd>
        </div>
        {s.ownerName && (
          <div>
            <dt className="text-xs text-subtle">Runs as</dt>
            <dd>{s.ownerName}</dd>
          </div>
        )}
      </dl>
      <ErrorBox error={patch.error ?? run.error ?? del.error ?? test.error ?? rotate.error} />
      {test.data && test.variables === s.id && (
        <p
          className={`mt-2 text-sm ${test.data.ok ? 'text-success' : 'text-danger'}`}
          role="status"
          data-testid="test-result"
        >
          {test.data.ok
            ? `Test delivered${test.data.httpStatus ? ` (HTTP ${test.data.httpStatus})` : ''}.`
            : `Test failed${test.data.httpStatus ? ` (HTTP ${test.data.httpStatus})` : ''}: ${test.data.error ?? 'unknown error'}`}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(editable || managed) && (
          <Button
            variant="primary"
            loading={run.isPending && run.variables === s.id}
            onClick={() =>
              run.mutate(s.id, {
                onSuccess: (r) => toast.success(r.ref ? `Emitted ${r.ref}` : (r.summary ?? 'Started')),
              })
            }
          >
            <Play aria-hidden="true" className="size-4" />
            Run now
          </Button>
        )}
        {testable && editable && (
          <Button
            loading={test.isPending && test.variables === s.id}
            onClick={() => test.mutate(s.id)}
            data-testid="test-delivery"
          >
            <Send aria-hidden="true" className="size-4" />
            Send test
          </Button>
        )}
        <Button onClick={() => setHistory(!history)} aria-expanded={history} data-testid="toggle-history">
          <History aria-hidden="true" className="size-4" />
          History
          <Chevron aria-hidden="true" className="size-4" />
        </Button>
        {managed ? (
          // Owned by an interest: it is edited, paused and deleted there (the server answers 409 otherwise).
          <span className="text-sm" data-testid="schedule-managed">
            Managed by interest{' '}
            <Link to={`/interests?open=${s.interestId}`} className="font-medium underline">
              {s.interestName ?? 'interest'}
            </Link>
          </span>
        ) : editable ? (
          <>
            <Button onClick={onEdit}>
              <Pencil aria-hidden="true" className="size-4" />
              Edit
            </Button>
            <Button
              disabled={patch.isPending}
              onClick={() =>
                patch.mutate(
                  { id: s.id, body: { enabled: !s.enabled } },
                  { onSuccess: () => toast.success(s.enabled ? 'Schedule paused' : 'Schedule resumed') },
                )
              }
            >
              {s.enabled ? (
                <Pause aria-hidden="true" className="size-4" />
              ) : (
                <Play aria-hidden="true" className="size-4" />
              )}
              {s.enabled ? 'Pause' : 'Resume'}
            </Button>
            {webhook && (
              <Button
                loading={rotate.isPending && rotate.variables === s.id}
                onClick={() =>
                  rotate.mutate(s.id, {
                    onSuccess: (r) => onSecret({ name: s.name, value: r.webhookSecret }),
                  })
                }
              >
                <KeyRound aria-hidden="true" className="size-4" />
                New secret
              </Button>
            )}
            <Button variant="danger-ghost" className="ml-auto" onClick={() => setConfirming(true)}>
              <Trash2 aria-hidden="true" className="size-4" />
              Delete
            </Button>
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              title={`Delete the schedule "${s.name}"?`}
              description="It stops running and its history goes with it. Cards it already emitted are kept."
              confirmLabel="Delete schedule"
              pending={del.isPending}
              onConfirm={() =>
                del.mutate(s.id, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast.success('Schedule deleted');
                  },
                  onError: () => setConfirming(false),
                })
              }
            />
          </>
        ) : (
          <span className="text-sm text-subtle" data-testid="schedule-readonly">
            Only the Owner and Admins change this one.
          </span>
        )}
      </div>
      {run.data && run.variables === s.id && (
        <p className="mt-2 text-sm text-fg" data-testid="run-result">
          {run.data.ref ? `Emitted ${run.data.ref}.` : (run.data.summary ?? 'Started.')}
        </p>
      )}
      {history && <RunHistory schedule={s} />}
    </Panel>
  );
}
