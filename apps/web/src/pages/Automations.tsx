import {
  BRIEF_PLAYBOOKS,
  type BriefPlaybookDto,
  type CreateScheduleResponse,
  isBriefPlaybookKey,
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
  useRevokeSecret,
  useRotateSecret,
  useRunSchedule,
  useScheduleList,
  useTestSchedule,
} from '../api/queries/schedules.ts';
import { BriefPlaybookDialog } from '../components/schedules/BriefPlaybookDialog.tsx';
import { BriefPlaybooks } from '../components/schedules/BriefPlaybooks.tsx';
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
import { actionLabel, describeAction, describeTrigger, hasOutputWebhook } from '../lib/schedules.ts';
import { formatDateTime } from '../lib/time.ts';

/**
 * Automations (formerly Schedules): a trigger (a time, an event, a labelled issue or nothing) and one action (a card, a regression, a DevOps
 * request, a BA task, an integration). Runs, history and the webhook delivery log are on each schedule; the jobs the
 * system runs by itself are listed read-only at the end.
 */
export function Automations() {
  const list = useScheduleList();
  const [wizard, setWizard] = useState<{ open: boolean; editing?: ScheduleDto }>({ open: false });
  const [secret, setSecret] = useState<{ name: string; value: string; url?: string | undefined } | null>(
    null,
  );
  const [playbookEdit, setPlaybookEdit] = useState<ScheduleDto | null>(null);
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
    if (c.webhookSecret) setSecret({ name: c.name, value: c.webhookSecret, url: c.hookUrlWithSecret });
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader
        title="Automations"
        sub="Run something on a time, when an event happens (a card reaches a stage, a ticket arrives), or when an issue gets a label. No agent ever polls: the server does."
        actions={
          <Button variant="primary" data-testid="new-schedule" onClick={() => setWizard({ open: true })}>
            <Plus aria-hidden="true" className="size-4" />
            New automation
          </Button>
        }
      />
      {secret && (
        <SecretNotice
          name={secret.name}
          value={secret.value}
          url={secret.url}
          onClose={() => setSecret(null)}
        />
      )}
      <BriefPlaybooks schedules={schedules} onSecret={(v) => setSecret({ name: v.name, value: v.value })} />
      {list.isPending && <ListSkeleton label="Loading automations" rows={2} />}
      <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      {ordered.map(([group, items]) => (
        <section key={group} aria-label={group} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold tracking-wide text-subtle uppercase">{group}</h2>
          <ul className="flex flex-col gap-3" aria-label={`Automations of ${group}`} data-testid="schedules">
            {items.map((s) => (
              <li key={s.id} data-testid={`schedule-${s.name}`}>
                <ScheduleRow
                  schedule={s}
                  onEdit={() =>
                    s.action.kind === 'create_card' && s.action.playbook
                      ? setPlaybookEdit(s)
                      : setWizard({ open: true, editing: s })
                  }
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
          title="No automations yet"
          description="An automation runs something for you: a weekly regression, a card when a phase is completed, a Slack message when a card is finalized, a morning e-mail digest, or new GitHub issues taken into intake."
          action={
            <Button variant="primary" onClick={() => setWizard({ open: true })}>
              Create the first automation
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
      {playbookEdit && playbookEdit.action.kind === 'create_card' && playbookEdit.action.playbook && (
        <BriefPlaybookDialog
          playbook={playbookDto(playbookEdit)}
          schedule={playbookEdit}
          onClose={() => setPlaybookEdit(null)}
          onSecret={(v) => setSecret({ name: v.name, value: v.value })}
        />
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

/** The playbook of an installed schedule, for its edit dialog. */
function playbookDto(s: ScheduleDto): BriefPlaybookDto {
  const key = s.action.kind === 'create_card' && s.action.playbook ? s.action.playbook.key : '';
  const p = isBriefPlaybookKey(key) ? BRIEF_PLAYBOOKS[key] : BRIEF_PLAYBOOKS.morning_plan;
  return {
    key: p.key,
    name: p.name,
    description: p.description,
    cadence: p.cadence,
    defaultTime: p.defaultTime,
    defaultWeekday: p.defaultWeekday ?? null,
    defaultOwnerRole: p.defaultOwnerRole,
    maxWords: p.maxWords,
    scheduleId: s.id,
  };
}

function SecretNotice({
  name,
  value,
  url,
  onClose,
}: {
  name: string;
  value: string;
  url?: string | undefined;
  onClose: () => void;
}) {
  if (url)
    return (
      <Callout tone="info" data-testid="hook-secret">
        <p className="font-medium">Web address of "{name}"</p>
        <p className="mt-1 text-sm">
          Copy it now: it is shown only this once, because only a fingerprint of the secret in it is kept.
          Whoever has it can start this automation, so keep it private. POST JSON to it, or send the secret as{' '}
          <code>Authorization: Bearer ...</code> to the address without the secret. A new secret or switching
          it off ends the old one at once.
        </p>
        <p
          className="mt-2 rounded-control bg-sunken px-2 py-1.5 font-mono text-sm break-all text-fg"
          data-testid="hook-url-value"
        >
          {url}
        </p>
        <div className="mt-2 flex gap-2">
          <Button onClick={() => void navigator.clipboard?.writeText(url)}>Copy</Button>
          <Button onClick={onClose}>I have saved it</Button>
        </div>
      </Callout>
    );
  return (
    <Callout tone="info" data-testid="webhook-secret">
      <p className="font-medium">Signing secret of "{name}"</p>
      <p className="mt-1 text-sm">
        Copy it now: it is shown only this once. Your receiver checks the <code>X-Guildwise-Signature</code>{' '}
        header against it (<code>X-AOM-Signature</code> is still sent with the same value until October 2027).
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
  onSecret: (v: { name: string; value: string; url?: string | undefined }) => void;
}) {
  const patch = usePatchSchedule();
  const run = useRunSchedule();
  const del = useDeleteSchedule();
  const test = useTestSchedule();
  const rotate = useRotateSecret();
  const revoke = useRevokeSecret();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [history, setHistory] = useState(false);
  const webhook = isWebhookAction(s.action);
  const incoming = s.trigger.kind === 'webhook_in';
  const outputHook = hasOutputWebhook(s.action);
  const testable =
    webhook ||
    (s.action.kind === 'integration' && s.action.integration === 'email') ||
    (s.action.kind === 'create_card' && !!s.action.deliverOutput);
  const editable = s.canEdit !== false;
  const Chevron = history ? ChevronDown : ChevronRight;

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold text-fg [overflow-wrap:anywhere]">{s.name}</h3>
        <Badge tone="brand">{actionLabel(s.action)}</Badge>
        {s.action.kind === 'create_card' && s.action.playbook && <Badge>Playbook</Badge>}
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
          {incoming && s.hookUrl && (
            <dd className="mt-1 font-mono text-xs break-all text-muted" data-testid="hook-url">
              {window.location.origin}
              {s.hookUrl}/&lt;secret&gt;
              {s.hasWebhookSecret ? '' : ' (switched off: make a new secret to use it)'}
            </dd>
          )}
        </div>
        <div>
          <dt className="text-xs text-subtle">Next run</dt>
          <dd data-testid="schedule-next">
            {s.nextFireAt
              ? formatDateTime(s.nextFireAt)
              : s.trigger.kind === 'event' || incoming
                ? incoming
                  ? 'when its address is called'
                  : 'on the event'
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
          {test.data.results ? (
            <span className="flex flex-col gap-1">
              {test.data.results.map((r) => (
                <span key={r.runId} className={r.ok || r.pending ? 'text-success' : 'text-danger'}>
                  {r.target}:{' '}
                  {r.pending
                    ? 'sent to the workstation; the result appears in the history'
                    : r.ok
                      ? 'delivered'
                      : `failed: ${r.error ?? 'unknown error'}`}
                </span>
              ))}
            </span>
          ) : test.data.ok ? (
            `Test delivered${test.data.httpStatus ? ` (HTTP ${test.data.httpStatus})` : ''}.`
          ) : (
            `Test failed${test.data.httpStatus ? ` (HTTP ${test.data.httpStatus})` : ''}: ${test.data.error ?? 'unknown error'}`
          )}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {editable && (
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
        {editable ? (
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
                  { onSuccess: () => toast.success(s.enabled ? 'Automation paused' : 'Automation resumed') },
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
            {(webhook || incoming || outputHook) && (
              <Button
                loading={rotate.isPending && rotate.variables === s.id}
                onClick={() =>
                  rotate.mutate(s.id, {
                    onSuccess: (r) =>
                      onSecret({ name: s.name, value: r.webhookSecret, url: r.hookUrlWithSecret }),
                  })
                }
              >
                <KeyRound aria-hidden="true" className="size-4" />
                New secret
              </Button>
            )}
            {incoming && s.hasWebhookSecret && (
              <Button
                loading={revoke.isPending && revoke.variables === s.id}
                onClick={() =>
                  revoke.mutate(s.id, {
                    onSuccess: () =>
                      toast.success('The web address is switched off until you make a new secret'),
                  })
                }
                data-testid="revoke-secret"
              >
                Switch the secret off
              </Button>
            )}
            <Button variant="danger-ghost" className="ml-auto" onClick={() => setConfirming(true)}>
              <Trash2 aria-hidden="true" className="size-4" />
              Delete
            </Button>
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              title={`Delete the automation "${s.name}"?`}
              description="It stops running and its history goes with it. Cards it already emitted are kept."
              confirmLabel="Delete automation"
              pending={del.isPending}
              onConfirm={() =>
                del.mutate(s.id, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast.success('Automation deleted');
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
