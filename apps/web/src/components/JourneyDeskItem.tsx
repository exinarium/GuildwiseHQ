import type { DeskItemDto } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/client.ts';
import { useDecideGate, useWaitAction } from '../api/queries/journeys.ts';
import { Button, TextArea, useToast } from './ui.tsx';

export const JOURNEY_DESK_SUBKINDS = ['journey_gate', 'journey_wait_escalated', 'journey_wait_link'] as const;
export const isJourneyDeskSubkind = (s: string | null | undefined): boolean =>
  !!s && (JOURNEY_DESK_SUBKINDS as readonly string[]).includes(s);

/**
 * The desk item of a journey gate (approve or reject), of a wait that timed out (extend, continue, cancel) and of a
 * client link to pass on (the link, resend, done). The ids come from the item's data; the page of the instance has the rest.
 */
export function JourneyDeskItem({ item }: { item: DeskItemDto }) {
  const toast = useToast();
  const decide = useDecideGate();
  const act = useWaitAction();
  const [note, setNote] = useState('');
  const data = (item.data ?? {}) as { waitId?: string; instanceId?: string };
  const waitId = data.waitId ?? '';
  const fail = (e: unknown) => toast.error(errorMessage(e));
  const link = data.instanceId ? (
    <Link to={`/journeys/instances/${data.instanceId}`} className="font-medium text-brand-text underline">
      Open the journey
    </Link>
  ) : null;
  const busy = decide.isPending || act.isPending;

  if (item.subkind === 'journey_gate') {
    return (
      <div className="mt-2 flex flex-col gap-3" data-testid="journey-gate-desk-item">
        {link && <p className="text-sm text-muted">{link} to look at the record first, or decide here.</p>}
        <TextArea label="Note (required to reject)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-testid="journey-gate-note" />
        <div className="sticky-actions flex flex-wrap gap-2 max-md:[&>button]:flex-1">
          <Button
            loading={decide.isPending}
            disabled={busy}
            data-testid="journey-gate-approve"
            onClick={() => decide.mutate({ waitId, decision: 'approved', ...(note.trim() ? { note: note.trim() } : {}) }, { onError: fail })}
          >
            Approve
          </Button>
          <Button
            variant="danger"
            disabled={busy || !note.trim()}
            data-testid="journey-gate-reject"
            onClick={() => decide.mutate({ waitId, decision: 'rejected', note: note.trim() }, { onError: fail })}
          >
            Reject
          </Button>
        </div>
      </div>
    );
  }
  if (item.subkind === 'journey_wait_escalated') {
    return (
      <div className="mt-2 flex flex-col gap-3" data-testid="journey-escalation-desk-item">
        {link && <p className="text-sm text-muted">{link} for the full history, or decide here.</p>}
        <div className="sticky-actions flex flex-wrap gap-2 max-md:[&>button]:flex-1">
          <Button
            variant="secondary"
            disabled={busy}
            data-testid="journey-wait-extend"
            onClick={() => act.mutate({ waitId, action: 'extend', body: { duration: { amount: 1, unit: 'days' } } }, { onError: fail })}
          >
            Wait 1 more day
          </Button>
          <Button disabled={busy} data-testid="journey-wait-continue" onClick={() => act.mutate({ waitId, action: 'continue' }, { onError: fail })}>
            Continue the journey
          </Button>
          <Button variant="danger" disabled={busy} data-testid="journey-wait-cancel" onClick={() => act.mutate({ waitId, action: 'cancel' }, { onError: fail })}>
            Cancel the journey
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-3" data-testid="journey-link-desk-item">
      {link && <p className="text-sm text-muted">{link} to copy the client's personal link.</p>}
      <div className="sticky-actions flex flex-wrap gap-2 max-md:[&>button]:flex-1">
        <Button variant="secondary" disabled={busy} data-testid="journey-link-resend" onClick={() => act.mutate({ waitId, action: 'resend-link' }, { onError: fail })}>
          Make a new link
        </Button>
      </div>
    </div>
  );
}
