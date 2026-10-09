import {
  type DevOpsRequestDto,
  HYGIENE_CADENCES_HOURS,
  hygieneCadenceLabel,
  type WorkstationDto,
} from '@aom/shared';
import { type FormEvent, useState } from 'react';
import {
  useClearSudoPassword,
  useCreateDevOpsRequest,
  useDevOpsRequest,
  useDevOpsRequests,
  usePatchDevOpsAccess,
  useResolveDevOpsApproval,
  useRunHygiene,
  useSetHygieneInterval,
  useSetSudoPassword,
  useVerifyRights,
} from '../api/queries/devops.ts';
import { formatDateTime } from '../lib/time.ts';
import { Badge, Button, ErrorBox, Select, TextArea, TextInput } from './ui.tsx';

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
    <section className="mt-3 border-t border-line pt-3" data-testid={`devops-panel-${w.name}`}>
      <h3 className="text-sm font-semibold">DevOps engineer</h3>
      <p className="text-xs text-subtle">
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
      <RightsStatus w={w} access={access} />
      <HygieneSettings w={w} />
      <AskDevOps workstationId={w.id} name={w.name} />
      <ul
        className="mt-3 flex flex-col gap-2"
        data-testid="devops-requests"
        aria-label={`DevOps requests on ${w.name}`}
      >
        {requests.data?.length === 0 && <li className="text-sm text-subtle">No requests yet.</li>}
        {requests.data?.map((r) => (
          <RequestRow key={r.id} r={r} />
        ))}
      </ul>
    </section>
  );
}

const RIGHT_LABEL = {
  install: 'Install packages and tools',
  docker: 'Docker',
  sudo: 'Elevated privileges (sudo)',
  paths: 'Writable paths',
} as const;

/**
 * A ticked right is a promise until the runner proves it on the machine: one badge per ticked right (verified or failed,
 * with the reason and how to fix it), and the sudo password form when sudo needs one.
 */
function RightsStatus({
  w,
  access,
}: {
  w: WorkstationDto;
  access: NonNullable<WorkstationDto['devopsAccess']>;
}) {
  const verify = useVerifyRights();
  const ticked = (
    [
      ['install', access.allowInstall],
      ['docker', access.allowDocker],
      ['sudo', access.sudo],
      ['paths', access.allowedPaths.length > 0],
    ] as const
  ).filter(([, on]) => on);
  if (ticked.length === 0) return null;
  const checks = w.rights?.checks ?? {};
  const stale = !!w.rights?.stale;
  return (
    <div className="mt-3 rounded-control border border-line p-2" data-testid={`rights-${w.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">Rights on this machine</h4>
        <Button disabled={verify.isPending || !w.connected} onClick={() => verify.mutate(w.id)}>
          Verify now
        </Button>
        {!w.connected && <span className="text-xs text-subtle">The runner is offline.</span>}
        {w.rights && (
          <span className="text-xs text-subtle">
            Checked {formatDateTime(w.rights.checkedAt)}
            {stale ? ' (before your last change)' : ''}
          </span>
        )}
      </div>
      <ul className="mt-2 flex flex-col gap-2">
        {ticked.map(([key]) => {
          const c = checks[key];
          return (
            <li key={key} data-testid={`right-${key}`} data-status={c?.status ?? 'unchecked'}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={c ? (c.status === 'verified' ? 'green' : 'red') : 'neutral'}>
                  {c ? (c.status === 'verified' ? 'verified' : 'failed') : 'not checked'}
                </Badge>
                <span className="font-medium">{RIGHT_LABEL[key]}</span>
              </div>
              {c && <p className="ml-1 text-xs text-subtle">{c.reason}</p>}
              {c?.status === 'failed' && c.fix && <p className="ml-1 text-xs">How to fix: {c.fix}</p>}
            </li>
          );
        })}
      </ul>
      {access.sudo && <SudoPassword w={w} />}
      <ErrorBox error={verify.error} />
    </div>
  );
}

/**
 * The sudo password. It is encrypted in this browser with the runner's own key; the server only relays ciphertext, the
 * runner keeps it in its data folder (readable by the runner user only), and it is never shown again.
 */
function SudoPassword({ w }: { w: WorkstationDto }) {
  const set = useSetSudoPassword();
  const clear = useClearSudoPassword();
  const [pw, setPw] = useState('');
  const sudo = w.sudo;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!pw) return;
    set.mutate({ workstationId: w.id, password: pw }, { onSuccess: () => setPw('') });
  };
  return (
    <form
      onSubmit={submit}
      aria-label={`Sudo password for ${w.name}`}
      className="mt-3 border-t border-line pt-2"
      autoComplete="off"
    >
      <p className="text-sm font-medium">
        Sudo password{' '}
        {sudo?.passwordSet ? (
          <Badge tone={sudo.works === false ? 'red' : 'green'}>
            {sudo.works === false ? 'stored, not accepted' : 'stored'}
          </Badge>
        ) : (
          <Badge tone="neutral">not set</Badge>
        )}
      </p>
      <p className="text-xs text-subtle">
        Only needed when sudo asks for a password on this machine. It is encrypted here with a key only this
        runner holds, stored on the runner alone and used for the DevOps engineer's commands only. It is never
        shown again and never written to a log.
        {sudo?.keyId ? ` Key ${sudo.keyId} (the same as \`aom-runner doctor\` shows).` : ''}
      </p>
      <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <TextInput
            label={sudo?.passwordSet ? 'New sudo password' : 'Sudo password'}
            type="password"
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </div>
        <Button type="submit" variant="primary" disabled={!pw || set.isPending || !w.connected}>
          Send to {w.name}
        </Button>
        {sudo?.passwordSet && (
          <Button disabled={clear.isPending} onClick={() => clear.mutate(w.id)}>
            Forget it
          </Button>
        )}
      </div>
      {set.isSuccess && (
        <p role="status" className="text-sm text-success">
          Sent. The runner checks it and the badge above updates.
        </p>
      )}
      <ErrorBox error={set.error ?? clear.error} />
    </form>
  );
}

/** Repository hygiene: how often the DevOps engineer tidies this machine's project repositories, and a manual run. */
function HygieneSettings({ w }: { w: WorkstationDto }) {
  const set = useSetHygieneInterval();
  const run = useRunHygiene();
  const h = w.hygiene;
  const hours = h?.intervalHours ?? 24;
  return (
    <div className="mt-3 rounded-control border border-line p-2" data-testid={`hygiene-${w.name}`}>
      <h4 className="text-sm font-semibold">Repository hygiene</h4>
      <p className="text-xs text-subtle">
        The DevOps engineer fetches and pulls this machine's project repositories, commits unsaved work to the
        working branch you confirmed, pushes, and removes merged agent branches and stale worktrees. A
        repository with no confirmed working branch is never committed to: you are asked which branch it is.
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="w-full sm:w-48">
          <Select
            label="Run"
            value={String(hours)}
            disabled={set.isPending}
            onChange={(e) => set.mutate({ workstationId: w.id, intervalHours: Number(e.target.value) })}
          >
            {HYGIENE_CADENCES_HOURS.map((n) => (
              <option key={n} value={n}>
                {hygieneCadenceLabel(n)}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate(w.id)}>
          Run hygiene now
        </Button>
      </div>
      <p className="mt-2 text-xs text-subtle" data-testid="hygiene-status">
        {h?.lastRunAt ? `Last run ${formatDateTime(h.lastRunAt)}` : 'Not run yet'}
        {h?.lastStatus ? ` (${h.lastStatus.replace('_', ' ')})` : ''}
        {h?.nextRunAt ? `; next ${formatDateTime(h.nextRunAt)}` : '; the schedule is off'}
        {h && h.openFindings > 0 ? `; ${h.openFindings} open finding${h.openFindings === 1 ? '' : 's'}` : ''}.
      </p>
      {run.isSuccess && (
        <p role="status" className="text-sm text-success">
          {run.data.alreadyRunning ? 'A hygiene run is already queued or running.' : 'Hygiene run requested.'}
        </p>
      )}
      <ErrorBox error={set.error ?? run.error} />
    </div>
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
      className="rounded-control border border-line p-2"
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
        <span className="text-xs text-subtle">
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
  if (!q.data) return <p className="mt-2 text-sm text-subtle">Loading thread…</p>;
  const { request, messages, changes } = q.data;
  const awaiting = request.status === 'needs_approval' && request.approval && !request.approval.resolution;
  return (
    <div className="mt-2 flex flex-col gap-2 text-sm" data-testid="devops-thread">
      <ol className="flex flex-col gap-1.5">
        {messages.map((m) => (
          <li key={m.id}>
            <span className="font-medium">{m.authorName}</span>{' '}
            <span className="text-xs text-subtle">
              {m.kind} · {formatDateTime(m.createdAt)}
            </span>
            <p className="whitespace-pre-wrap">{m.body}</p>
          </li>
        ))}
      </ol>
      {changes.length > 0 && (
        <div data-testid="devops-changes">
          <p className="text-xs font-medium text-subtle">Environment changes</p>
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
        <div className="rounded-control bg-warning-soft p-2" data-testid="devops-approval">
          <p className="font-medium">Approval needed: {request.approval.action}</p>
          <p>{request.approval.reason}</p>
          {request.approval.commands.length > 0 && (
            <pre
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard reachable
              tabIndex={0}
              className="mt-1 overflow-x-auto rounded bg-side p-2 text-xs text-side-strong"
            >
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
        <p className="text-danger">{request.resultSummary}</p>
      )}
    </div>
  );
}
