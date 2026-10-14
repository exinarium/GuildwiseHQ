import type { CeoTaskDtoApi } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { useCeoTasks, useCreateCeoTask, usePatchCeoTask } from '../../api/queries/ceo.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Button, ErrorBox, Panel, Spinner, TextArea, TextInput } from '../ui.tsx';

const STATUS: Record<string, { label: string; tone: 'neutral' | 'blue' | 'amber' | 'green' | 'red' }> = {
  open: { label: 'Open', tone: 'blue' },
  in_progress: { label: 'In progress', tone: 'blue' },
  waiting_owner: { label: 'Waiting for you', tone: 'amber' },
  waiting_work: { label: 'Waiting for the work', tone: 'amber' },
  done: { label: 'Done', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};
const CLOSED = ['done', 'failed', 'cancelled'];

function TaskRow({ t }: { t: CeoTaskDtoApi }) {
  const patch = usePatchCeoTask();
  const [note, setNote] = useState('');
  const st = STATUS[t.status] ?? { label: t.status, tone: 'neutral' as const };
  const closed = CLOSED.includes(t.status);
  return (
    <li className="py-3" data-testid="ceo-task" data-status={t.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium text-fg">{t.title}</p>
          {t.request && <p className="mt-0.5 text-sm whitespace-pre-wrap text-muted">{t.request}</p>}
        </div>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      <p className="mt-1 text-xs text-subtle">
        Added {formatDateTime(t.createdAt)}
        {t.dueAt ? `, due ${formatDateTime(t.dueAt)}` : ''}
        {t.threadId && (
          <>
            {' · '}
            <Link to={`/chat/${t.threadId}`} className="text-brand-text hover:underline">
              Open the chat
            </Link>
          </>
        )}
      </p>
      {t.notes.length > 0 && (
        <ul className="mt-2 space-y-1 border-l-2 border-line pl-3 text-sm text-muted">
          {t.notes.map((n) => (
            <li key={`${n.at}-${n.by}`}>
              <span className="text-xs text-subtle">
                {formatDateTime(n.at)} · {n.by}:
              </span>{' '}
              {n.note}
            </li>
          ))}
        </ul>
      )}
      {!closed && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          aria-label={`Note on ${t.title}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) patch.mutate({ id: t.id, note: note.trim() }, { onSuccess: () => setNote('') });
          }}
        >
          <input
            aria-label={`Add a note to ${t.title}`}
            className="h-8 min-w-0 flex-1 rounded-control border border-control bg-surface px-2 text-sm"
            value={note}
            maxLength={4000}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note for the CEO"
          />
          <Button size="sm" type="submit" disabled={!note.trim()} loading={patch.isPending}>
            Add note
          </Button>
          <Button size="sm" variant="ghost" onClick={() => patch.mutate({ id: t.id, status: 'cancelled' })}>
            Cancel task
          </Button>
        </form>
      )}
      <ErrorBox error={patch.error} />
    </li>
  );
}

/** Tasks you give the CEO; it works them between its other duties and reports back. */
export function TasksTab() {
  const q = useCeoTasks();
  const create = useCreateCeoTask();
  const [title, setTitle] = useState('');
  const [request, setRequest] = useState('');
  if (q.isPending) return <Spinner label="Loading the tasks" />;
  if (!q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const tasks = q.data.tasks;
  const open = tasks.filter((t) => !CLOSED.includes(t.status));
  const closed = tasks.filter((t) => CLOSED.includes(t.status));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    create.mutate(
      { title: title.trim(), ...(request.trim() ? { request: request.trim() } : {}) },
      {
        onSuccess: () => {
          setTitle('');
          setRequest('');
        },
      },
    );
  };
  return (
    <div className="flex flex-col gap-4" data-testid="ceo-tasks">
      <Panel title="Give the CEO a task">
        <form onSubmit={submit} className="flex flex-col gap-3" aria-label="New task">
          <TextInput label="Title" maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />
          <TextArea
            label="What you want (optional)"
            rows={3}
            maxLength={4000}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            hint="The CEO works it between its other duties and tells you when it is done."
          />
          <ErrorBox error={create.error} />
          <div>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!title.trim()}>
              Add task
            </Button>
          </div>
        </form>
      </Panel>
      <Panel title={`Open tasks (${open.length})`}>
        {open.length === 0 ? (
          <p className="text-sm text-muted">No open tasks.</p>
        ) : (
          <ul className="divide-y divide-line">
            {open.map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
          </ul>
        )}
      </Panel>
      {closed.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-fg">
            Finished ({closed.length})
          </summary>
          <ul className="mt-2 divide-y divide-line rounded-card border border-line bg-surface px-4">
            {closed.map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
