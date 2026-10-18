import type { DeskItemDto } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApprovalSendBack, useApprove, useCardDiff } from '../api/queries/approval.ts';
import { DiffView } from './DiffView.tsx';
import { Button, ErrorBox, TextArea } from './ui.tsx';

/** The desk item of an approval step: approve, or send the card back with a comment (same actions as the card page). */
export function ApprovalDeskItem({ item }: { item: DeskItemDto }) {
  const cardId = item.card?.id ?? '';
  const approve = useApprove(cardId);
  const sendBack = useApprovalSendBack(cardId);
  const [note, setNote] = useState('');
  const [failing, setFailing] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const diff = useCardDiff(cardId, showDiff);
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
      {/* lean team: the owner reads the final diff of the reviewed commit before approving it (a card without one has none). */}
      <div className="flex flex-col gap-2">
        <Button
          variant="secondary"
          onClick={() => setShowDiff((o) => !o)}
          data-testid="approval-desk-diff-toggle"
        >
          {showDiff ? 'Hide the diff' : 'Show the diff'}
        </Button>
        {showDiff && diff.isLoading && <p className="text-sm text-subtle">Loading the diff…</p>}
        {showDiff && diff.error && <p className="text-sm text-subtle">No diff was stored for this card.</p>}
        {showDiff && diff.data && <DiffView diff={diff.data.body} truncated={diff.data.truncated} />}
      </div>
      <TextArea
        label={failing ? 'What is missing? (required)' : 'Note (optional)'}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={failing ? 4 : 2}
        data-testid="approval-desk-note"
      />
      <div className="sticky-actions flex flex-wrap gap-2 max-md:[&>button]:flex-1">
        {!failing ? (
          <>
            <Button
              variant="primary"
              loading={approve.isPending}
              disabled={busy}
              data-testid="approval-desk-approve"
              onClick={() =>
                approve.mutate({
                  ...(note.trim() ? { note: note.trim() } : {}),
                  // the commit whose diff was shown here (when the diff was opened)
                  ...(showDiff && diff.data?.sha ? { sha: diff.data.sha } : {}),
                })
              }
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
