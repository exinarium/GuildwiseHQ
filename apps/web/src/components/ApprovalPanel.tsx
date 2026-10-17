import type { CardApproval } from '@aom/shared';
import { useState } from 'react';
import { useApprovalSendBack, useApprove } from '../api/queries/approval.ts';
import { formatDateTime } from '../lib/time.ts';
import { ApprovalReview } from './ApprovalReview.tsx';
import { Badge, Button, ErrorBox, Panel, TextArea } from './ui.tsx';

const STATE_LABEL: Record<CardApproval['state'], string> = {
  open: 'Waiting for approval',
  approved: 'Approved',
  sent_back: 'Sent back',
};

/**
 * An approval step on the card page (backlog #16): who is asked, where an approval and a send back lead, and the two
 * actions. The same actions are on the desk item.
 */
export function ApprovalPanel({ cardId, approval }: { cardId: string; approval: CardApproval }) {
  const approve = useApprove(cardId);
  const sendBack = useApprovalSendBack(cardId);
  const [note, setNote] = useState('');
  const [failing, setFailing] = useState(false);
  const busy = approve.isPending || sendBack.isPending;
  const open = approval.state === 'open';
  const tone = approval.state === 'approved' ? 'green' : approval.state === 'sent_back' ? 'red' : 'amber';

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {approval.stageLabel}
          <Badge tone={tone} data-testid="approval-state">
            {STATE_LABEL[approval.state]}
          </Badge>
        </span>
      }
      data-testid="approval-panel"
    >
      <div className="flex flex-col gap-3">
        {open && (
          <p className="text-sm text-muted" data-testid="approval-approver">
            <span className="font-medium text-fg">{approval.approver.name}</span> approves this card
            {approval.fellBack
              ? ' (the step names someone who is not available, so the Owner was asked)'
              : ''}
            .{approval.approveTo ? ` Approved, it goes on to "${approval.approveTo}".` : ''}
            {approval.sendBackTo
              ? ` Sent back, it returns to "${approval.sendBackTo}" with the comment.`
              : ''}
          </p>
        )}
        {approval.review && <ApprovalReview cardId={cardId} review={approval.review} defaultOpen={open} />}
        {approval.decision && (
          <p className="text-sm text-muted" data-testid="approval-decision">
            {approval.decision.kind === 'approved' ? 'Approved' : 'Sent back'} by {approval.decision.byName},{' '}
            {formatDateTime(approval.decision.at)}
            {approval.decision.note ? `: ${approval.decision.note}` : ''}
          </p>
        )}
        {approval.sentBackCount > 0 && (
          <p className="text-xs text-subtle">Sent back {approval.sentBackCount} time(s) so far.</p>
        )}
        {open && approval.canAct && (
          <>
            <TextArea
              label={failing ? 'What is missing? (required)' : 'Note (optional)'}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={failing ? 4 : 2}
              data-testid="approval-note"
            />
            <div className="flex flex-wrap gap-2">
              {!failing ? (
                <>
                  <Button
                    variant="primary"
                    loading={approve.isPending}
                    disabled={busy}
                    data-testid="approval-approve"
                    onClick={() => approve.mutate(note.trim() ? { note: note.trim() } : {})}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    data-testid="approval-fail"
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
                    data-testid="approval-send-back"
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
          </>
        )}
        {open && !approval.canAct && (
          <p className="text-sm text-subtle" data-testid="approval-readonly">
            Only {approval.approver.name}, the project owner and the organization's Owners and Admins can
            decide this.
          </p>
        )}
      </div>
    </Panel>
  );
}
