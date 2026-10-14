import type { DeskItemDto } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useQaPass, useQaSendBack, useQaSkip } from '../api/queries/qa.ts';
import { Button, ErrorBox, TextArea } from './ui.tsx';

/**
 * The desk item of manual QA: pass, skip the test or send the card back with a comment. The same actions as the QA panel
 * on the card (which also shows the test steps and can hand the test to someone else).
 */
export function QaDeskItem({ item }: { item: DeskItemDto }) {
  const cardId = item.card?.id ?? '';
  const pass = useQaPass(cardId);
  const skip = useQaSkip(cardId);
  const sendBack = useQaSendBack(cardId);
  const [note, setNote] = useState('');
  const [failing, setFailing] = useState(false);
  const busy = pass.isPending || skip.isPending || sendBack.isPending;
  if (!item.card) return <p className="mt-2 text-sm text-subtle">This card is gone.</p>;
  return (
    <div className="mt-2 flex flex-col gap-3" data-testid="qa-desk-item">
      <p className="text-sm text-muted">
        <Link to={`/cards/${item.card.id}`} className="font-medium text-brand-text underline">
          Open {item.card.ref}
        </Link>{' '}
        to see the test steps, or answer here.
      </p>
      <TextArea
        label={failing ? 'What failed? (required)' : 'Note (optional)'}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={failing ? 4 : 2}
        data-testid="qa-desk-note"
      />
      <div className="flex flex-wrap gap-2">
        {!failing && (
          <>
            <Button
              variant="primary"
              loading={pass.isPending}
              disabled={busy}
              data-testid="qa-desk-pass"
              onClick={() => pass.mutate(note.trim() ? { note: note.trim() } : {})}
            >
              Pass
            </Button>
            <Button
              loading={skip.isPending}
              disabled={busy}
              data-testid="qa-desk-skip"
              onClick={() => skip.mutate(note.trim() ? { reason: note.trim() } : {})}
            >
              Skip the test
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              data-testid="qa-desk-fail"
              onClick={() => setFailing(true)}
            >
              Send back
            </Button>
          </>
        )}
        {failing && (
          <>
            <Button
              variant="danger"
              loading={sendBack.isPending}
              disabled={!note.trim() || busy}
              data-testid="qa-desk-send-back"
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
      <ErrorBox error={pass.error ?? skip.error ?? sendBack.error} />
    </div>
  );
}
