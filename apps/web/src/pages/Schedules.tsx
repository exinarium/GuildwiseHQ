import {
  DEFAULT_SCHEDULE_CRON,
  FEED_DEFAULT_MAX_ITEMS,
  feedMaxItems,
  type ProjectDto,
  SCHEDULE_PRESETS,
  type ScheduleDto,
} from '@aom/shared';
import { CalendarClock } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { useProjects } from '../api/queries/projects.ts';
import {
  useCreateSchedule,
  useDeleteSchedule,
  usePatchSchedule,
  useRunSchedule,
  useSchedules,
} from '../api/queries/schedules.ts';
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  Select,
  TextArea,
  TextInput,
  useToast,
} from '../components/ui.tsx';
import { buildFeedTemplate, defaultTimezone, describeCron } from '../lib/feeds.ts';
import { formatDateTime } from '../lib/time.ts';

const CUSTOM = 'custom';

/** Recurring tasks: cron with a time zone ("Daily at 07:00"), run now, pause. Schedules always fire on time. */
export function Schedules() {
  const schedules = useSchedules();
  const projects = useProjects();
  const feedProjects = (projects.data ?? []).filter((p) => p.workflowKey === 'feed' && p.myRole === 'owner');

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3">
      <PageHeader
        title="Schedules"
        sub="Each run emits a card that takes the next free agent ahead of normal work; if none is free, one extra shift starts."
      />
      {schedules.isPending && <ListSkeleton label="Loading schedules" rows={2} />}
      <ErrorBox error={schedules.error} onRetry={() => schedules.refetch()} />
      <ul className="flex flex-col gap-3" aria-label="Schedules" data-testid="schedules">
        {(schedules.data ?? []).map((s) => (
          <li key={s.id} data-testid={`schedule-${s.name}`}>
            <ScheduleRow schedule={s} projectKey={projects.data?.find((p) => p.id === s.projectId)?.key} />
          </li>
        ))}
      </ul>
      {schedules.data?.length === 0 && (
        <EmptyState
          data-testid="schedules-empty"
          icon={CalendarClock}
          title="No schedules yet"
          description="A schedule runs a feed scan on a cadence. Create a project with the Feed workflow, then schedule its scan below."
          action={
            feedProjects.length === 0 ? (
              <ButtonLink to="/projects" variant="primary">
                Create a feed project
              </ButtonLink>
            ) : undefined
          }
        />
      )}
      <NewSchedule projects={feedProjects} />
    </div>
  );
}

function ScheduleRow({ schedule: s, projectKey }: { schedule: ScheduleDto; projectKey: string | undefined }) {
  const patch = usePatchSchedule();
  const run = useRunSchedule();
  const del = useDeleteSchedule();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const fields = s.cardTemplate.fields as Record<string, unknown>;
  const topic = typeof fields.topic === 'string' ? fields.topic : undefined;
  const description = typeof fields.description === 'string' ? fields.description.trim() : '';
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-fg">{s.name}</h2>
        <Badge>{s.kind}</Badge>
        {projectKey && (
          <Link to={`/p/${projectKey}/feed`} className="text-xs underline">
            {projectKey}
          </Link>
        )}
        <Badge tone={s.enabled ? 'green' : 'amber'}>{s.enabled ? 'Enabled' : 'Paused'}</Badge>
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
      <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm text-fg sm:grid-cols-2">
        <div>
          <dt className="text-xs text-subtle">When</dt>
          <dd data-testid="schedule-when">
            {describeCron(s.cron)} <span className="text-subtle">({s.timezone})</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Next run</dt>
          <dd data-testid="schedule-next">{s.nextFireAt ? formatDateTime(s.nextFireAt) : 'not scheduled'}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Topic</dt>
          <dd>{topic ?? s.cardTemplate.title}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Max items</dt>
          <dd data-testid="schedule-max-items">{feedMaxItems(fields)}</dd>
        </div>
        {description && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-subtle">Description</dt>
            <dd className="whitespace-pre-wrap" data-testid="schedule-description">
              {description}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-subtle">Last run</dt>
          <dd data-testid="schedule-last">{s.lastFiredAt ? formatDateTime(s.lastFiredAt) : 'never'}</dd>
        </div>
      </dl>
      <ErrorBox error={patch.error ?? run.error ?? del.error} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          loading={run.isPending}
          onClick={() => run.mutate(s.id, { onSuccess: (r) => toast.success(`Emitted ${r.ref}`) })}
        >
          Run now
        </Button>
        {s.interestId ? (
          // Owned by an interest: it is edited, paused and deleted there (the server answers 409 otherwise).
          <span className="text-sm" data-testid="schedule-managed">
            Managed by interest{' '}
            <Link to={`/interests?open=${s.interestId}`} className="font-medium underline">
              {s.interestName ?? 'interest'}
            </Link>
          </span>
        ) : (
          <>
            <Button
              disabled={patch.isPending}
              onClick={() =>
                patch.mutate(
                  { id: s.id, body: { enabled: !s.enabled } },
                  { onSuccess: () => toast.success(s.enabled ? 'Schedule paused' : 'Schedule resumed') },
                )
              }
            >
              {s.enabled ? 'Pause' : 'Resume'}
            </Button>
            <Button variant="danger-ghost" className="ml-auto" onClick={() => setConfirming(true)}>
              Delete
            </Button>
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              title={`Delete the schedule "${s.name}"?`}
              description="It stops running. Cards it already emitted are kept."
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
        )}
      </div>
      {run.data && (
        <p className="mt-2 text-sm text-fg" data-testid="run-result">
          Emitted {run.data.ref}.
        </p>
      )}
    </Panel>
  );
}

function NewSchedule({ projects }: { projects: ProjectDto[] }) {
  const create = useCreateSchedule();
  const toast = useToast();
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<string>(SCHEDULE_PRESETS[0].id);
  const [cron, setCron] = useState<string>(DEFAULT_SCHEDULE_CRON);
  const [timezone, setTimezone] = useState(defaultTimezone());
  const [topic, setTopic] = useState('');
  const [sites, setSites] = useState('');
  const [description, setDescription] = useState('');
  const [maxItems, setMaxItems] = useState(String(FEED_DEFAULT_MAX_ITEMS));
  const [err, setErr] = useState('');
  const chosen = projects.find((p) => p.id === projectId) ?? projects[0];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return setErr('Create a feed project first');
    if (!name.trim() || !topic.trim()) return setErr('A name and a topic are required');
    const expression =
      preset === CUSTOM ? cron.trim() : (SCHEDULE_PRESETS.find((p) => p.id === preset)?.cron ?? cron);
    setErr('');
    create.mutate(
      {
        projectId: chosen.id,
        name: name.trim(),
        cron: expression,
        timezone: timezone.trim() || 'UTC',
        cardTemplate: buildFeedTemplate({
          title: `${name.trim()}`,
          topic,
          description,
          sites,
          maxItems,
        }),
      },
      {
        onSuccess: () => {
          toast.success('Schedule created');
          setName('');
          setTopic('');
          setDescription('');
          setSites('');
        },
      },
    );
  };

  return (
    <Panel>
      <h2 className="mb-3 text-lg font-semibold text-fg">New feed schedule</h2>
      <p className="mb-4 text-sm text-muted" data-testid="schedules-interests-hint">
        Feeds are easier to manage as{' '}
        <Link to="/interests" className="text-brand-text underline">
          Interests
        </Link>
        : one place for the topic, its scan, your taste rules and its notes.
      </p>
      {projects.length === 0 ? (
        <p className="text-sm text-muted">
          You own no project with the Feed workflow.{' '}
          <Link to="/projects" className="text-brand-text underline">
            Create one
          </Link>{' '}
          and choose the Feed workflow.
        </p>
      ) : (
        <form onSubmit={submit} aria-label="New schedule" className="grid gap-4 sm:grid-cols-2" noValidate>
          <Select label="Project" value={chosen?.id ?? ''} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} {p.name}
              </option>
            ))}
          </Select>
          <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Select label="Runs" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {SCHEDULE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM}>Custom cron expression</option>
          </Select>
          <TextInput
            label="Time zone"
            hint="IANA name, e.g. Africa/Johannesburg"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
          {preset === CUSTOM && (
            <TextInput
              label="Cron expression"
              hint="minute hour day month weekday"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
            />
          )}
          <TextInput
            label="Topic"
            hint="A short label"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
          <TextInput
            label="Max items"
            hint="The best N items overall, whatever their kind (articles, videos, podcasts)"
            inputMode="numeric"
            value={maxItems}
            onChange={(e) => setMaxItems(e.target.value)}
          />
          <div className="sm:col-span-2">
            <TextArea
              label="Description"
              hint="Markdown. What you want in detail: the angle, what to include or leave out, the level. Optional, but the agents follow it over the topic."
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <TextArea
            label="Preferred sites (searched first, one per line)"
            value={sites}
            onChange={(e) => setSites(e.target.value)}
          />
          <div className="flex flex-col gap-2 sm:col-span-2">
            {err && (
              <Callout tone="danger" role="alert">
                {err}
              </Callout>
            )}
            <ErrorBox error={create.error} />
            <div>
              <Button type="submit" variant="primary" loading={create.isPending}>
                Create schedule
              </Button>
            </div>
          </div>
        </form>
      )}
    </Panel>
  );
}
