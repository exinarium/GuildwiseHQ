import { DEFAULT_SCHEDULE_CRON, type ProjectDto, SCHEDULE_PRESETS, type ScheduleDto } from '@aom/shared';
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
  ErrorBox,
  PageHeader,
  Panel,
  Select,
  Spinner,
  TextArea,
  TextInput,
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
      {schedules.isPending && <Spinner label="Loading schedules" />}
      <ErrorBox error={schedules.error} />
      <ul className="flex flex-col gap-3" aria-label="Schedules" data-testid="schedules">
        {(schedules.data ?? []).map((s) => (
          <li key={s.id} data-testid={`schedule-${s.name}`}>
            <ScheduleRow schedule={s} projectKey={projects.data?.find((p) => p.id === s.projectId)?.key} />
          </li>
        ))}
      </ul>
      {schedules.data?.length === 0 && (
        <Panel>
          <p className="text-sm text-zinc-500" data-testid="schedules-empty">
            No schedules yet. Create a project with the Feed workflow, then schedule its scan below.
          </p>
        </Panel>
      )}
      <NewSchedule projects={feedProjects} />
    </div>
  );
}

function ScheduleRow({ schedule: s, projectKey }: { schedule: ScheduleDto; projectKey: string | undefined }) {
  const patch = usePatchSchedule();
  const run = useRunSchedule();
  const del = useDeleteSchedule();
  const fields = s.cardTemplate.fields as { topic?: string; maxPerKind?: Record<string, number> };
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{s.name}</h2>
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
        <p className="mt-1 text-xs text-red-700 dark:text-red-400" data-testid="schedule-error">
          {s.lastError} Retrying with growing pauses.
        </p>
      )}
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-zinc-500">When</dt>
          <dd data-testid="schedule-when">
            {describeCron(s.cron)} <span className="text-zinc-500">({s.timezone})</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Next run</dt>
          <dd data-testid="schedule-next">{s.nextFireAt ? formatDateTime(s.nextFireAt) : 'not scheduled'}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Topic</dt>
          <dd>{fields.topic ?? s.cardTemplate.title}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Last run</dt>
          <dd data-testid="schedule-last">{s.lastFiredAt ? formatDateTime(s.lastFiredAt) : 'never'}</dd>
        </div>
      </dl>
      <ErrorBox error={patch.error ?? run.error ?? del.error} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate(s.id)}>
          Run now
        </Button>
        <Button
          disabled={patch.isPending}
          onClick={() => patch.mutate({ id: s.id, body: { enabled: !s.enabled } })}
        >
          {s.enabled ? 'Pause' : 'Resume'}
        </Button>
        <Button
          variant="danger"
          disabled={del.isPending}
          onClick={() => {
            if (window.confirm(`Delete the schedule "${s.name}"?`)) del.mutate(s.id);
          }}
        >
          Delete
        </Button>
      </div>
      {run.data && (
        <p className="mt-2 text-sm" data-testid="run-result">
          Emitted {run.data.ref}.
        </p>
      )}
    </Panel>
  );
}

function NewSchedule({ projects }: { projects: ProjectDto[] }) {
  const create = useCreateSchedule();
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<string>(SCHEDULE_PRESETS[0].id);
  const [cron, setCron] = useState<string>(DEFAULT_SCHEDULE_CRON);
  const [timezone, setTimezone] = useState(defaultTimezone());
  const [topic, setTopic] = useState('');
  const [sites, setSites] = useState('');
  const [maxArticles, setMaxArticles] = useState('5');
  const [maxVideos, setMaxVideos] = useState('3');
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
          sites,
          maxArticles,
          maxVideos,
        }),
      },
      {
        onSuccess: () => {
          setName('');
          setTopic('');
          setSites('');
        },
      },
    );
  };

  return (
    <Panel>
      <h2 className="mb-2 text-sm font-semibold">New feed schedule</h2>
      {projects.length === 0 ? (
        <p className="text-sm text-zinc-500">
          You own no project with the Feed workflow.{' '}
          <Link to="/projects" className="underline">
            Create one
          </Link>{' '}
          and choose the Feed workflow.
        </p>
      ) : (
        <form onSubmit={submit} aria-label="New schedule" className="grid gap-3 sm:grid-cols-2" noValidate>
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
          <TextInput label="Topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <TextArea
            label="Preferred sites (searched first, one per line)"
            value={sites}
            onChange={(e) => setSites(e.target.value)}
          />
          <TextInput
            label="Max articles"
            inputMode="numeric"
            value={maxArticles}
            onChange={(e) => setMaxArticles(e.target.value)}
          />
          <TextInput
            label="Max videos"
            inputMode="numeric"
            value={maxVideos}
            onChange={(e) => setMaxVideos(e.target.value)}
          />
          <div className="flex flex-col gap-2 sm:col-span-2">
            {err && (
              <p role="alert" className="text-xs font-medium text-red-600">
                {err}
              </p>
            )}
            <ErrorBox error={create.error} />
            <div>
              <Button type="submit" variant="primary" disabled={create.isPending}>
                Create schedule
              </Button>
            </div>
          </div>
        </form>
      )}
    </Panel>
  );
}
