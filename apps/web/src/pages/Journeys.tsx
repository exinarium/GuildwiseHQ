import type { JourneyTemplate } from '@aom/shared';
import { JOURNEY_INSTANCE_STATUSES } from '@aom/shared';
import { Plus, Route } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { errorMessage } from '../api/client.ts';
import {
  useCreateJourney,
  useJourneyInstances,
  useJourneys,
  useJourneyTemplates,
} from '../api/queries/journeys.ts';
import { useProjects } from '../api/queries/projects.ts';
import { JourneyTemplateGallery } from '../components/journeys/JourneyTemplateGallery.tsx';
import { panelId, tabId } from '../components/ui/Tabs.tsx';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Select,
  Tabs,
  useToast,
} from '../components/ui.tsx';

const STATUS_TONE = {
  running: 'info',
  waiting: 'warning',
  stuck: 'danger',
  completed: 'success',
  cancelled: 'neutral',
} as const;
const when = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');

/** Journeys: the processes (workflows linked by handoffs on one record) and the instances running on records. */
export function Journeys() {
  const nav = useNavigate();
  const toast = useToast();
  const projects = useProjects();
  const [tab, setTab] = useState<'journeys' | 'running'>('journeys');
  const [projectId, setProjectId] = useState('');
  const [journeyId, setJourneyId] = useState('');
  const [status, setStatus] = useState('');
  const [stepId, setStepId] = useState('');
  const [gallery, setGallery] = useState(false);
  const list = useJourneys(projectId || undefined);
  const templates = useJourneyTemplates();
  const instances = useJourneyInstances({
    ...(projectId ? { projectId } : {}),
    ...(journeyId ? { journeyId } : {}),
    ...(status ? { status } : {}),
    ...(stepId ? { stepId } : {}),
  });
  const create = useCreateJourney();
  const target = projectId || projects.data?.[0]?.id || '';
  const pickTemplate = (t: JourneyTemplate | null) =>
    create.mutate(t ? { projectId: target, templateId: t.id } : { projectId: target, definition: blank() }, {
      onSuccess: (r) => nav(`/journeys/${r.id}`),
      onError: (e) => toast.error(errorMessage(e)),
    });
  const steps = [...new Map((instances.data ?? []).map((i) => [i.stepId, i.stepLabel])).entries()];

  return (
    <div>
      <PageHeader
        title="Journeys"
        sub="One process from first contact to outcome: workflows linked by handoffs, all working on one record."
        actions={
          <Button onClick={() => setGallery(true)} disabled={!target}>
            <Plus aria-hidden="true" className="size-4" /> New journey
          </Button>
        }
      />
      <div className="mb-4 max-w-sm">
        <Select label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All my projects</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>
      <Tabs
        label="Journeys"
        prefix="journeys"
        value={tab}
        onChange={(v) => setTab(v as 'journeys' | 'running')}
        tabs={[
          { id: 'journeys', label: 'Journeys' },
          { id: 'running', label: 'Running' },
        ]}
        className="mb-4"
      />
      {tab === 'journeys' ? (
        <div
          role="tabpanel"
          id={panelId('journeys', 'journeys')}
          aria-labelledby={tabId('journeys', 'journeys')}
        >
          {list.isLoading ? (
            <ListSkeleton />
          ) : list.error ? (
            <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
          ) : (list.data ?? []).length === 0 ? (
            <EmptyState
              icon={Route}
              title="No journeys yet"
              description="Start from the rentals template or build your own."
            />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2" data-testid="journey-list">
              {list.data?.map((j) => (
                <li key={j.id} className="rounded-card border border-line bg-surface p-4">
                  <Link
                    to={`/journeys/${j.id}`}
                    className="text-lg font-semibold text-fg underline-offset-2 hover:underline"
                  >
                    {j.name}
                  </Link>
                  <p className="mt-1 text-sm text-muted">
                    {j.stepCount} steps · for a {j.recordType} · version {j.version}
                  </p>
                  <p className="mt-1 text-sm">{j.running} running</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div
          role="tabpanel"
          id={panelId('journeys', 'running')}
          aria-labelledby={tabId('journeys', 'running')}
        >
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Select label="Journey" value={journeyId} onChange={(e) => setJourneyId(e.target.value)}>
              <option value="">All journeys</option>
              {(list.data ?? []).map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </Select>
            <Select label="Step" value={stepId} onChange={(e) => setStepId(e.target.value)}>
              <option value="">Any step</option>
              {steps.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
            <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option>
              {JOURNEY_INSTANCE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          {instances.isLoading ? (
            <ListSkeleton />
          ) : instances.error ? (
            <ErrorBox error={instances.error} onRetry={() => void instances.refetch()} />
          ) : (instances.data ?? []).length === 0 ? (
            <EmptyState
              icon={Route}
              title="Nothing running"
              description="Open a journey and start it on a client, matter or deal."
            />
          ) : (
            <ul className="flex flex-col gap-2" data-testid="instance-list">
              {instances.data?.map((i) => (
                <li key={i.id} className="rounded-control border border-line bg-surface p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/journeys/instances/${i.id}`}
                      className="font-medium text-fg underline-offset-2 hover:underline"
                    >
                      {i.recordName}
                    </Link>
                    <span className="text-sm text-muted">{i.journeyName}</span>
                    <Badge tone={STATUS_TONE[i.status]}>{i.status}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    At “{i.stepLabel}” · started {when(i.startedAt)} · last change {when(i.updatedAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Dialog
        open={gallery}
        onOpenChange={setGallery}
        size="xl"
        title="New journey"
        description="Start from a template or from nothing."
      >
        <JourneyTemplateGallery
          templates={templates.data ?? []}
          busy={create.isPending}
          onPick={pickTemplate}
        />
        <div className="mt-4">
          <Button variant="secondary" loading={create.isPending} onClick={() => pickTemplate(null)}>
            Start with an empty journey
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function blank() {
  return {
    name: 'New journey',
    description: '',
    recordType: 'client' as const,
    firstStepId: 'step',
    steps: [{ kind: 'workflow' as const, id: 'step', label: 'First step', workflowKey: null, fieldsIn: [] }],
    handoffs: [],
  };
}
