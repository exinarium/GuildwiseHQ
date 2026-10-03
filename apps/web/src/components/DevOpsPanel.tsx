import type { DevOpsRequestDto, WorkstationDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import {
  useCreateDevOpsRequest,
  useDevOpsRequest,
  useDevOpsRequests,
  usePatchDevOpsAccess,
  useResolveDevOpsApproval,
} from '../api/queries/devops.ts';
import { formatDateTime } from '../lib/time.ts';
import { Badge, Button, ErrorBox, TextArea, TextInput } from './ui.tsx';

const TONE = {
  queued: 'neutral',
  running: 'blue',
  needs_approval: 'amber',
  done: 'green',
  failed: 'red',
} as const;

const STATUS_LABEL: Record<DevOpsRequestDto['status'], string> = {
  queued: 'queued',
  running: 'running',
  needs_approval: 'needs approval',
  done: 'done',
  failed: 'failed',
};

/** A workstation's DevOps engineer: granted access, "Ask DevOps" and the request threads (docs/SPEC.md DevOps engineer). */
export function DevOpsPanel({ w }: { w: WorkstationDto }) {
  const access = w.devopsAccess ?? { allowInstall: false, allowDocker: false, allowedPaths: [], sudo: false };
  const patch = usePatchDevOpsAccess();
  const requests = useDevOpsRequests(w.id);
  const [paths, setPaths] = useState<string | null>(null);
  const toggle = (key: 'allowInstall' | 'allowDocker' | 'sudo') =>
    patch.mutate({ workstationId: w.id, body: { [key]: !access[key] } });
  const pathsText = paths ?? access.allowedPaths.join('\n');
  const savePaths = () =>
    patch.mutate(
      {
        workstationId: w.id,
        body: {
          allowedPaths: pathsText
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean),
        },
      },
      { onSuccess: () => setPaths(null) },
    );

  return (
    <section
      className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800"
      data-testid={`devops-panel-${w.name}`}
    >
      <h3 className="text-sm font-semibold">DevOps engineer</h3>
      <p className="text-xs text-zinc-500">
        Sets up and maintains this machine. Anything outside the access below waits for your approval.
      </p>
      <fieldset className="mt-2 grid gap-1 text-sm sm:grid-cols-3" aria-label={`DevOps access on ${w.name}`}>
        {(
          [
            ['allowInstall', 'Install packages and tools'],
            ['allowDocker', 'Docker'],
            ['sudo', 'Elevated privileges (sudo)'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={access[key]}
              disabled={patch.isPending}
              onChange={() => toggle(key)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="mt-2 flex flex-col gap-1 sm:flex-row sm:items-end">
        <div className="flex-1">
          <TextArea
            label="Writable paths outside the agent sandbox (one per line)"
            rows={2}
            value={pathsText}
            onChange={(e) => setPaths(e.target.value)}
          />
        </div>
        <Button disabled={paths === null || patch.isPending} onClick={savePaths}>
          Save paths
        </Button>
      </div>
      <ErrorBox error={patch.error} />
      <AskDevOps workstationId={w.id} name={w.name} />
      <ul
        className="mt-3 flex flex-col gap-2"
        data-testid="devops-requests"
        aria-label={`DevOps requests on ${w.name}`}
      >
        {requests.data?.length === 0 && <li className="text-sm text-zinc-500">No requests yet.</li>}
        {requests.data?.map((r) => (
          <RequestRow key={r.id} r={r} />
        ))}
      </ul>
    </section>
  );
}

function AskDevOps({ workstationId, name }: { workstationId: string; name: string }) {
  const create = useCreateDevOpsRequest();
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return setErr('Describe what you need');
    setErr(undefined);
    create.mutate({ workstationId, summary: text.trim() }, { onSuccess: () => setText('') });
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Ask DevOps on ${name}`}
      className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
    >
      <div className="flex-1">
        <TextInput
          label="Ask DevOps"
          placeholder="e.g. start the app, install Docker"
          value={text}
          onChange={(e) => setText(e.target.value)}
          error={err}
        />
      </div>
      <Button type="submit" variant="primary" disabled={create.isPending}>
        Send request
      </Button>
      <ErrorBox error={create.error} />
    </form>
  );
}

function RequestRow({ r }: { r: DevOpsRequestDto }) {
  const [open, setOpen] = useState(r.status === 'needs_approval');
  return (
    <li
      className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800"
      data-testid={`devops-request-${r.summary.slice(0, 40)}`}
      data-status={r.status}
    >
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-2 text-left text-sm"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Badge tone={TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
        <span className="min-w-0 flex-1 truncate font-medium">{r.summary}</span>
        <span className="text-xs text-zinc-500">
          {r.requestedBy.name ?? r.requestedBy.kind}
          {r.cardRef ? ` · ${r.cardRef}` : ''} · {formatDateTime(r.createdAt)}
        </span>
      </button>
      {open && <RequestThread id={r.id} />}
    </li>
  );
}

function RequestThread({ id }: { id: string }) {
  const q = useDevOpsRequest(id);
  const resolve = useResolveDevOpsApproval();
  const [note, setNote] = useState('');
  if (!q.data) return <p className="mt-2 text-sm text-zinc-500">Loading thread…</p>;
  const { request, messages, changes } = q.data;
  const awaiting = request.status === 'needs_approval' && request.approval && !request.approval.resolution;
  return (
    <div className="mt-2 flex flex-col gap-2 text-sm" data-testid="devops-thread">
      <ol className="flex flex-col gap-1.5">
        {messages.map((m) => (
          <li key={m.id}>
            <span className="font-medium">{m.authorName}</span>{' '}
            <span className="text-xs text-zinc-500">
              {m.kind} · {formatDateTime(m.createdAt)}
            </span>
            <p className="whitespace-pre-wrap">{m.body}</p>
          </li>
        ))}
      </ol>
      {changes.length > 0 && (
        <div data-testid="devops-changes">
          <p className="text-xs font-medium text-zinc-500">Environment changes</p>
          <ul className="list-disc pl-5">
            {changes.map((c) => (
              <li key={c.id}>
                {c.summary}
                {c.commands.length > 0 && <code className="ml-1 text-xs">{c.commands.join(' ; ')}</code>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {awaiting && request.approval && (
        <div className="rounded-md bg-amber-50 p-2 dark:bg-amber-950/40" data-testid="devops-approval">
          <p className="font-medium">Approval needed: {request.approval.action}</p>
          <p>{request.approval.reason}</p>
          {request.approval.commands.length > 0 && (
            <pre className="mt-1 overflow-x-auto rounded bg-zinc-950 p-2 text-xs text-zinc-100">
              {request.approval.commands.join('\n')}
            </pre>
          )}
          <TextInput label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="mt-2 flex gap-2">
            <Button
              variant="primary"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ id, resolution: 'approved', note })}
            >
              Approve
            </Button>
            <Button
              variant="danger"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ id, resolution: 'rejected', note })}
            >
              Reject
            </Button>
          </div>
          <ErrorBox error={resolve.error} />
        </div>
      )}
      {request.status === 'failed' && request.resultSummary && (
        <p className="text-red-700 dark:text-red-400">{request.resultSummary}</p>
      )}
    </div>
  );
}
