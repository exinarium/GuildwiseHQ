import type { DeskItemDto } from '@aom/shared';
import { useState } from 'react';
import { useDismissDeskItem, useResolveDeskItem } from '../api/queries/desk.ts';
import { diffWords } from '../lib/outbound.ts';
import { Button, ErrorBox, TextArea } from './ui.tsx';

/** Words added and removed, shown inline: what the manager's edit changed in the draft. */
export function DiffView({ before, after, testId }: { before: string; after: string; testId?: string }) {
  // A diff is positional and never reordered: the position is its stable key.
  const parts = diffWords(before, after).map((p, position) => ({ ...p, key: `${position}-${p.kind}` }));
  return (
    <p className="rounded-control bg-sunken p-2 text-sm whitespace-pre-wrap" data-testid={testId}>
      {parts.map((p) =>
        p.kind === 'same' ? (
          <span key={p.key}>{p.text}</span>
        ) : p.kind === 'added' ? (
          <ins key={p.key} className="bg-success-soft text-success-soft-fg no-underline">
            {p.text}
          </ins>
        ) : (
          <del key={p.key} className="bg-danger-soft text-danger-soft-fg">
            {p.text}
          </del>
        ),
      )}
    </p>
  );
}

/**
 * The approval for an outbound update (docs/SPEC.md "External systems boundary"): the draft in the manager's voice,
 * editable, with a diff of what they changed. Nothing is posted before Approve; the text that is approved is the text
 * that is posted, by this card owner's own workstation.
 */
export function OutboundApproval({ item }: { item: DeskItemDto }) {
  const resolve = useResolveDeskItem();
  const dismiss = useDismissDeskItem();
  const [text, setText] = useState(item.body);
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const edited = text.trim() !== item.body.trim();
  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="outbound-approval">
      <TextArea
        label="Update (edit it before you approve; it is posted as you leave it)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid="outbound-text"
      />
      {edited && text.trim() && (
        <div data-testid="outbound-diff">
          <p className="mb-1 text-xs font-medium text-subtle">Your changes</p>
          <DiffView before={item.body} after={text} testId="outbound-diff-view" />
        </div>
      )}
      <p className="text-xs text-subtle">
        Nothing is posted until you approve. Your own workstation posts it with your own access; agent names
        and the team's inner workings are refused.
      </p>
      {rejecting && (
        <TextArea
          label="Why not (optional, kept on the card)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="outbound-reason"
        />
      )}
      <ErrorBox error={resolve.error ?? dismiss.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={resolve.isPending || !text.trim()}
          data-testid="outbound-approve"
          onClick={() =>
            resolve.mutate({
              id: item.id,
              body: { resolution: 'approved', ...(edited ? { editedBody: text.trim() } : {}) },
            })
          }
        >
          {edited ? 'Approve and post my edit' : 'Approve and post'}
        </Button>
        {rejecting ? (
          <Button
            variant="danger"
            disabled={resolve.isPending}
            data-testid="outbound-reject-confirm"
            onClick={() =>
              resolve.mutate({
                id: item.id,
                body: { resolution: 'rejected', ...(reason.trim() ? { note: reason.trim() } : {}) },
              })
            }
          >
            Reject, never post
          </Button>
        ) : (
          <Button data-testid="outbound-reject" onClick={() => setRejecting(true)}>
            Reject
          </Button>
        )}
      </div>
    </div>
  );
}
