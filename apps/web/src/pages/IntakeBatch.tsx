import {
  BATCH_MAX_TICKETS,
  type BatchItemDto,
  type BatchItemStatus,
  type BatchSummaryDto,
  parseBatchTickets,
} from '@aom/shared';
import { BriefcaseBusiness } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  useBatch,
  useBatches,
  useCancelBatch,
  useCreateBatch,
  useRetryBatchItem,
} from '../api/queries/intake-batch.ts';
import { useProjects } from '../api/queries/projects.ts';
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  EmptyState,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
  Select,
  TextArea,
} from '../components/ui.tsx';
import { ageLabel } from '../lib/time.ts';

const STATUS_TEXT: Record<BatchItemStatus, string> = {
  queued: 'Queued',
  reading: 'BA is working',
  waiting: 'Waiting for you',
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const STATUS_TONE: Record<BatchItemStatus, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  queued: 'neutral',
  reading: 'info',
  waiting: 'warning',
  done: 'success',
  skipped: 'neutral',
  failed: 'danger',
  cancelled: 'neutral',
};
const BATCH_TEXT = { running: 'Running', cancelled: 'Cancelled', done: 'Done' } as const;
const BATCH_TONE = { running: 'info', cancelled: 'neutral', done: 'success' } as const;

/** "3 done, 1 waiting, 2 queued": the counts that are not zero. */
export function countsText(c: BatchSummaryDto['counts']): string {
  return (Object.keys(STATUS_TEXT) as BatchItemStatus[])
    .filter((k) => c[k] > 0)
    .map((k) => `${c[k]} ${k === 'reading' ? 'in progress' : k}`)
    .join(', ');
}

/** The Batch mode of the Intake page: one ticket per line, an optional project and a note for all of them. */
export function BatchForm() {
  const nav = useNavigate();
  const create = useCreateBatch();
  const projects = useProjects();
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState('');
  const [note, setNote] = useState('');
  const parsed = parseBatchTickets(text.split('\n'));
  const tooMany = parsed.tickets.length > BATCH_MAX_TICKETS;
  const ready = parsed.tickets.length > 0 && parsed.invalid.length === 0 && !tooMany;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    create.mutate(
      {
        tickets: parsed.tickets.map((t) => t.key),
        ...(projectId ? { projectId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      { onSuccess: (b) => nav(`/intake/batches/${b.id}`) },
    );
  };

  return (
    <Panel>
      <form onSubmit={submit} aria-label="Start a batch intake" className="flex flex-col gap-3" noValidate>
        <TextArea
          label="Tickets, one per line"
          rows={6}
          placeholder={'ABC-101\nABC-102\nhttps://acme.atlassian.net/browse/ABC-103\nacme/web#12'}
          hint={`Jira keys or URLs and GitHub issues. Up to ${BATCH_MAX_TICKETS} tickets.`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {text.trim() && (
          <p className="text-sm text-muted" data-testid="batch-summary">
            {parsed.tickets.length} ticket(s)
            {parsed.duplicates.length > 0 && `, ${parsed.duplicates.length} repeated line(s) ignored`}
            {parsed.invalid.length > 0 && (
              <span className="text-danger-text" role="alert">
                . Not a ticket: {parsed.invalid.slice(0, 3).join(', ')}
                {parsed.invalid.length > 3 ? ` and ${parsed.invalid.length - 3} more` : ''}
              </span>
            )}
            {tooMany && (
              <span className="text-danger-text" role="alert">
                . Too many: a batch holds at most {BATCH_MAX_TICKETS}.
              </span>
            )}
          </p>
        )}
        <Select
          label="Project (optional)"
          hint="Leave empty and the BA maps each ticket itself, asking you when none fits."
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">BA decides per ticket</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.key}: {p.name}
            </option>
          ))}
        </Select>
        <TextArea
          label="Note for all tickets (optional)"
          rows={2}
          placeholder="For example: these are for the Q4 release; keep cards small."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <ErrorBox error={create.error} />
        <div>
          <Button type="submit" variant="primary" disabled={!ready} loading={create.isPending}>
            Start batch
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/** Earlier batches, newest first. */
export function BatchList() {
  const batches = useBatches();
  if ((batches.data?.length ?? 0) === 0) return null;
  return (
    <section className="mt-8" aria-label="Earlier batches">
      <h2 className="mb-2 text-lg font-semibold text-fg">Batches</h2>
      <ul
        className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface"
        data-testid="batch-list"
      >
        {batches.data?.map((b) => (
          <li key={b.id}>
            <Link
              to={`/intake/batches/${b.id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm hover:bg-sunken"
            >
              <span className="min-w-0 flex-1 truncate font-medium text-fg">
                {b.total} ticket(s){b.projectKey ? ` for ${b.projectKey}` : ''}
              </span>
              <Badge tone={BATCH_TONE[b.status]}>{BATCH_TEXT[b.status]}</Badge>
              <span className="text-xs text-subtle">{countsText(b.counts)}</span>
              <span className="text-xs text-subtle">{ageLabel(b.createdAt)} ago</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ItemRow({
  item,
  onRetry,
  retrying,
}: {
  item: BatchItemDto;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <li className="flex flex-col gap-1 px-4 py-3 text-sm" data-testid={`batch-item-${item.externalKey}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {item.url ? (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono font-semibold text-brand-text hover:underline"
          >
            {item.externalKey}
          </a>
        ) : (
          <span className="font-mono font-semibold text-fg">{item.externalKey}</span>
        )}
        <Badge tone={STATUS_TONE[item.status]} data-testid="batch-item-status">
          {STATUS_TEXT[item.status]}
        </Badge>
        {item.cards.map((c) => (
          <Link
            key={c.ref}
            to={`/cards/${c.ref}`}
            className="rounded-card border border-line px-2 py-0.5 text-xs hover:border-control"
            title={c.title ?? undefined}
          >
            <span className="font-mono font-semibold">{c.ref}</span>
            {c.title ? ` ${c.title}` : ''}
          </Link>
        ))}
        {item.status === 'failed' && (
          <Button size="sm" onClick={onRetry} loading={retrying}>
            Retry
          </Button>
        )}
      </div>
      {item.status === 'waiting' && (
        <p className="text-muted">
          {item.question}{' '}
          {item.deskItemId && (
            <Link to={`/desk#desk-item-${item.deskItemId}`} className="font-medium text-brand-text underline">
              Answer on the desk
            </Link>
          )}
        </p>
      )}
      {item.reason && item.status !== 'waiting' && <p className="text-subtle">{item.reason}</p>}
      {item.summary && item.status === 'done' && <p className="text-subtle">{item.summary}</p>}
    </li>
  );
}

/** One batch: its items with status, cards and questions, and the Cancel and Retry actions. */
export function BatchView() {
  const { id = '' } = useParams();
  const batch = useBatch(id);
  const cancel = useCancelBatch(id);
  const retry = useRetryBatchItem(id);
  if (batch.isPending) return <PageSkeleton label="Loading batch" panels={1} />;
  const b = batch.data;
  if (!b)
    return (
      <EmptyState
        icon={BriefcaseBusiness}
        title="This batch was not found"
        action={<ButtonLink to="/intake">Back to intake</ButtonLink>}
      />
    );
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Batch intake"
        back={{ to: '/intake', label: 'Intake' }}
        sub={`${b.total} ticket(s)${b.projectKey ? ` for ${b.projectKey}` : ''}${b.createdByName ? `, started by ${b.createdByName}` : ''}`}
        actions={
          b.status === 'running' ? (
            <Button onClick={() => cancel.mutate()} loading={cancel.isPending}>
              Cancel batch
            </Button>
          ) : undefined
        }
      />
      <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted">
        <Badge tone={BATCH_TONE[b.status]}>
          <span data-testid="batch-status">{BATCH_TEXT[b.status]}</span>
        </Badge>
        {countsText(b.counts)}
      </p>
      {b.note && <p className="mb-3 text-sm text-muted">Note: {b.note}</p>}
      {b.counts.waiting > 0 && (
        <Callout tone="warning" role="status" className="mb-3">
          {b.counts.waiting} ticket(s) wait for your answer on the desk. The other tickets carry on.
        </Callout>
      )}
      <ErrorBox error={cancel.error ?? retry.error} />
      <ul
        className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface"
        data-testid="batch-items"
      >
        {b.items.map((i) => (
          <ItemRow
            key={i.id}
            item={i}
            retrying={retry.isPending && retry.variables === i.id}
            onRetry={() => retry.mutate(i.id)}
          />
        ))}
      </ul>
    </div>
  );
}
