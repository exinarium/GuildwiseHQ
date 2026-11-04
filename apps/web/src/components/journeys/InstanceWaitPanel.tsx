import type { JourneyDefinition } from '@aom/shared';
import { useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import {
  type InstanceCall,
  type InstanceWait,
  useDecideGate,
  useInstanceWaits,
  useWaitAction,
} from '../../api/queries/journeys.ts';
import { relativeTime } from '../../lib/journeys.ts';
import { Badge, Button, Select, TextArea, useToast } from '../ui.tsx';

const WAIT_TONE: Record<string, 'info' | 'warning' | 'success' | 'neutral' | 'danger'> = {
  open: 'info',
  escalated: 'warning',
  resolved: 'success',
  timed_out: 'danger',
  cancelled: 'neutral',
};
const WAIT_WORDS: Record<string, string> = {
  open: 'Waiting',
  escalated: 'Waiting: the desk was asked',
  resolved: 'Ended',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
};
const CALL_TONE: Record<string, 'info' | 'warning' | 'success' | 'neutral' | 'danger'> = {
  pending: 'info',
  dispatched: 'warning',
  ok: 'success',
  failed: 'danger',
};

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '';
}

function WaitCard({ w, def, canAct }: { w: InstanceWait; def: JourneyDefinition; canAct: boolean }) {
  const toast = useToast();
  const act = useWaitAction();
  const decide = useDecideGate();
  const [note, setNote] = useState('');
  const [goto, setGoto] = useState('');
  const step = def.steps.find((s) => s.id === w.stepId);
  const open = w.status === 'open' || w.status === 'escalated';
  const fail = (e: unknown) => toast.error(errorMessage(e));
  const run = (
    action: 'continue' | 'cancel' | 'resend-link' | 'extend' | 'goto',
    body?: Record<string, unknown>,
  ) => act.mutate({ waitId: w.id, action, ...(body ? { body } : {}) }, { onError: fail });
  return (
    <li className="rounded-control border border-line bg-sunken/40 p-3" data-testid={`wait-${w.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{step?.label ?? w.stepId}</span>
        <Badge tone={WAIT_TONE[w.status] ?? 'neutral'}>{WAIT_WORDS[w.status] ?? w.status}</Badge>
        <Badge tone="neutral">{w.kind === 'gate' ? 'Approval' : w.kind}</Badge>
        {open && w.offline && ['held', 'sending', 'sent'].includes(w.offline.status) && (
          <Badge tone="warning">Documents pending, runner offline</Badge>
        )}
      </div>
      {open && w.offline && ['held', 'sending', 'sent'].includes(w.offline.status) && (
        <p className="mt-1 text-sm text-muted" data-testid="wait-offline">
          Runner offline since {when(w.offline.since)}
          {w.offline.linkSentAt
            ? `. Secure link emailed ${when(w.offline.linkSentAt)}${w.offline.linkExpiresAt ? `, expires ${when(w.offline.linkExpiresAt)}` : ''}.`
            : '. The link is emailed when the runner is back.'}
        </p>
      )}
      <p className="mt-1 text-sm text-muted" data-testid="wait-deadline">
        {w.deadlineAt
          ? open
            ? `Deadline ${when(w.deadlineAt)} (${relativeTime(w.deadlineAt)})`
            : `Deadline was ${when(w.deadlineAt)}`
          : open
            ? 'No deadline: ended by a person.'
            : ''}
        {w.remindersMax ? ` · Reminders ${w.remindersSent} of ${w.remindersMax}` : ''}
      </p>
      {w.linkUrl && open && (
        <p className="mt-1 text-sm [overflow-wrap:anywhere]" data-testid="wait-link">
          Client link:{' '}
          <a className="underline" href={w.linkUrl}>
            {w.linkUrl}
          </a>
        </p>
      )}
      {w.events.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-sm" data-testid="wait-events">
          {w.events.map((e, i) => (
            <li key={i}>
              <span className="text-subtle">{when(e.at)}</span> {e.text}
            </li>
          ))}
        </ul>
      )}
      {canAct && open && w.kind === 'gate' && (
        <div className="mt-3 flex flex-col gap-2">
          <TextArea
            label="Note (required to reject)"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-2 max-md:[&>button]:flex-1">
            <Button
              loading={decide.isPending}
              onClick={() =>
                decide.mutate(
                  { waitId: w.id, decision: 'approved', ...(note.trim() ? { note: note.trim() } : {}) },
                  { onError: fail },
                )
              }
            >
              Approve
            </Button>
            <Button
              variant="danger"
              disabled={!note.trim() || decide.isPending}
              onClick={() =>
                decide.mutate({ waitId: w.id, decision: 'rejected', note: note.trim() }, { onError: fail })
              }
            >
              Reject
            </Button>
          </div>
        </div>
      )}
      {canAct && open && w.kind !== 'gate' && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {w.kind !== 'manual' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => run('extend', { duration: { amount: 1, unit: 'days' } })}
            >
              Wait 1 more day
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => run('continue')}>
            Continue now
          </Button>
          {w.kind === 'form' && (
            <Button variant="secondary" size="sm" onClick={() => run('resend-link')}>
              Send a new link
            </Button>
          )}
          <Select label="Move to" value={goto} onChange={(e) => setGoto(e.target.value)}>
            <option value="">Pick a step…</option>
            {def.steps
              .filter((s) => s.id !== w.stepId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
          </Select>
          <Button
            variant="secondary"
            size="sm"
            disabled={!goto}
            onClick={() => run('goto', { stepId: goto })}
          >
            Move
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              if (window.confirm('Cancel the whole journey? This cannot be undone.')) run('cancel');
            }}
          >
            Cancel the journey
          </Button>
        </div>
      )}
    </li>
  );
}

function CallCard({ c, def }: { c: InstanceCall; def: JourneyDefinition }) {
  const step = def.steps.find((s) => s.id === c.stepId);
  return (
    <li className="rounded-control border border-line bg-sunken/40 p-3" data-testid={`call-${c.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{step?.label ?? c.stepId}</span>
        <Badge tone={CALL_TONE[c.status] ?? 'neutral'}>{c.status}</Badge>
        <Badge tone="neutral">Webhook call</Badge>
      </div>
      <p className="mt-1 text-sm text-muted">
        {c.attempts} {c.attempts === 1 ? 'attempt' : 'attempts'}
        {c.lastHttpStatus ? ` · last answer ${c.lastHttpStatus}` : ''}
        {c.nextAttemptAt && c.finishedAt === null ? ` · next try ${when(c.nextAttemptAt)}` : ''}
        {c.finishedAt ? ` · finished ${when(c.finishedAt)}` : ''}
      </p>
      {c.lastError && <p className="mt-1 text-sm text-danger-fg [overflow-wrap:anywhere]">{c.lastError}</p>}
    </li>
  );
}

/** Every wait, gate and webhook call of an instance with its deadline, its events and the actions a person may take. */
export function InstanceWaitPanel({
  instanceId,
  def,
  active,
}: {
  instanceId: string;
  def: JourneyDefinition;
  active: boolean;
}) {
  const q = useInstanceWaits(instanceId, active);
  const waits = q.data?.waits ?? [];
  const calls = q.data?.calls ?? [];
  if (waits.length === 0 && calls.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" data-testid="instance-waits">
      {waits.map((w) => (
        <WaitCard key={w.id} w={w} def={def} canAct={active} />
      ))}
      {calls.map((c) => (
        <CallCard key={c.id} c={c} def={def} />
      ))}
    </ul>
  );
}
