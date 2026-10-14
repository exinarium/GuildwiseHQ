import type { DeskItemDto } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApprovalSendBack, useApprove } from '../api/queries/approval.ts';
import { Button, ErrorBox, TextArea } from './ui.tsx';

/** The desk item of an approval step: approve, or send the card back with a comment (same actions as the card page). */
export function ApprovalDeskItem({ item }: { item: DeskItemDto }) {
  const cardId = item.card?.id ?? '';
  const approve = useApprove(cardId);
  const sendBack = useApprovalSendBack(cardId);
  const [note, setNote] = useState('');
  const [failing, setFailing] = useState(false);
  const busy = approve.isPending || sendBack.isPending;
  if (!item.card) return <p className="mt-2 text-sm text-subtle">This card is gone.</p>;
  return (
    <div className="mt-2 flex flex-col gap-3" data-testid="approval-desk-item">
      <p className="text-sm text-muted">
        <Link to={`/cards/${item.card.id}`} className="font-medium text-brand-text underline">
          Open {item.card.ref}
        </Link>{' '}
        to look at it first, or decide here.
      </p>
      <TextArea
        label={failing ? 'What is missing? (required)' : 'Note (optional)'}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={failing ? 4 : 2}
        data-testid="approval-desk-note"
      />
      <div className="flex flex-wrap gap-2">
        {!failing ? (
          <>
            <Button
              variant="primary"
              loading={approve.isPending}
              disabled={busy}
              data-testid="approval-desk-approve"
              onClick={() => approve.mutate(note.trim() ? { note: note.trim() } : {})}
            >
              Approve
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              data-testid="approval-desk-fail"
              onClick={() => setFailing(true)}
            >
              Send back
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="danger"
              loading={sendBack.isPending}
              disabled={!note.trim() || busy}
              data-testid="approval-desk-send-back"
              onClick={() => sendBack.mutate({ comment: note.trim() })}
            >
              Send back with this comment
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setFailing(false)}>
              Cancel
            </Button>
          </>
        )}
      </div>
      <ErrorBox error={approve.error ?? sendBack.error} />
    </div>
  );
}
