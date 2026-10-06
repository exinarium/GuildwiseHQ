import type { OutboundDraftDto, OutboundKind } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { useCreateOutboundDraft, useOutbound, useRetryOutbound } from '../api/queries/outbound.ts';
import { KIND_LABEL, STATUS_LABEL, systemLabel } from '../lib/outbound.ts';
import { formatDateTime } from '../lib/time.ts';
import { DiffView } from './OutboundApproval.tsx';
import { Badge, Button, ErrorBox, Panel, Select, TextArea } from './ui.tsx';

const tone = (s: OutboundDraftDto['status']) =>
  s === 'posted'
    ? 'green'
    : s === 'failed' || s === 'blocked'
      ? 'red'
      : s === 'rejected'
        ? 'neutral'
        : s === 'approved'
          ? 'blue'
          : 'amber';

/**
 * A card's updates to its ticket (docs/SPEC.md "External systems boundary"): each draft with who wrote it, what the
 * owner approved (a diff when they edited it), and what happened to it. Shown only for cards that came from a ticket.
 */
export function OutboundHistory({
  cardId,
  cardRef,
  ticket,
  isOwner,
  canDraft,
}: {
  cardId: string;
  cardRef: string;
  ticket: string | undefined;
  isOwner: boolean;
  canDraft: boolean;
}) {
  const list = useOutbound(cardRef);
  const retry = useRetryOutbound();
  const drafts = list.data ?? [];
  if (!ticket && drafts.length === 0) return null;
  return (
    <Panel>
      <div data-testid="outbound-history">
        <h2 className="mb-2 text-sm font-semibold">
          Updates to {ticket ?? 'the ticket'} ({drafts.length})
        </h2>
        <p className="mb-2 text-xs text-subtle">
          Nothing is posted to a company system without the card owner's approval.
        </p>
        {drafts.length === 0 && <p className="text-sm text-subtle">No updates drafted yet.</p>}
        <ul className="flex flex-col gap-2">
          {drafts.map((d) => (
            <li
              key={d.id}
              className="rounded-control border border-line p-2 text-sm"
              data-testid={`outbound-${d.id}`}
              data-status={d.status}
            >
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
                <Badge tone={tone(d.status)}>{STATUS_LABEL[d.status] ?? d.status}</Badge>
                <span>
                  {KIND_LABEL[d.kind]} for {systemLabel(d.externalSystem)} {d.externalKey}
                </span>
                <span title={formatDateTime(d.createdAt)}>
                  · drafted{d.draftedByName ? ` by ${d.draftedByName}` : ''}
                </span>
                {d.approvedByName && <span>· approved by {d.approvedByName}</span>}
                {d.edited && <Badge tone="violet">Edited</Badge>}
              </div>
              {d.edited && d.finalBody ? (
                <div className="mt-1.5">
                  <DiffView before={d.body} after={d.finalBody} testId={`outbound-diff-${d.id}`} />
                  <p className="mt-1 text-xs text-subtle">Posted as edited.</p>
                </div>
              ) : (
                <p className="mt-1.5 whitespace-pre-wrap" data-testid={`outbound-body-${d.id}`}>
                  {d.finalBody ?? d.body}
                </p>
              )}
              {d.status === 'posted' && d.externalRef && (
                <p className="mt-1 text-xs" data-testid={`outbound-ref-${d.id}`}>
                  Posted:{' '}
                  {/^https?:\/\//.test(d.externalRef) ? (
                    <a href={d.externalRef} target="_blank" rel="noreferrer" className="underline">
                      {d.externalRef}
                    </a>
                  ) : (
                    d.externalRef
                  )}
                </p>
              )}
              {d.status === 'rejected' && d.rejectReason && (
                <p className="mt-1 text-xs text-subtle">Rejected: {d.rejectReason}</p>
              )}
              {d.status === 'blocked' && (
                <p className="mt-1 text-xs text-danger" data-testid={`outbound-blocked-${d.id}`}>
                  Blocked before it reached the desk: it mentioned {d.blockedMatches.join(', ')}.
                </p>
              )}
              {d.status === 'pending' && d.deskItemId && (
                <p className="mt-1 text-xs">
                  <Link to={`/desk#desk-item-${d.deskItemId}`} className="underline">
                    Review it on the desk
                  </Link>
                </p>
              )}
              {d.status === 'failed' && (
                <div className="mt-1 text-xs text-danger">
                  <p data-testid={`outbound-error-${d.id}`}>Could not post: {d.error}</p>
                  {isOwner && (
                    <Button
                      className="mt-1"
                      disabled={retry.isPending}
                      data-testid={`outbound-retry-${d.id}`}
                      onClick={() => retry.mutate(d.id)}
                    >
                      Retry posting
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        <ErrorBox error={retry.error} />
        {ticket && canDraft && <DraftForm cardId={cardId} />}
      </div>
    </Panel>
  );
}

function DraftForm({ cardId }: { cardId: string }) {
  const create = useCreateOutboundDraft(cardId);
  const [kind, setKind] = useState<OutboundKind>('comment');
  const [body, setBody] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    create.mutate({ kind, body: body.trim() }, { onSuccess: () => setBody('') });
  };
  return (
    <form
      onSubmit={submit}
      className="mt-3 flex flex-col gap-2 border-t border-line pt-3"
      aria-label="Write an update"
    >
      <TextArea
        label="Write an update yourself"
        hint="It goes to the desk for approval like any other draft."
        value={body}
        onChange={(e) => setBody(e.target.value)}
        data-testid="outbound-new-text"
      />
      <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value as OutboundKind)}>
        {(Object.keys(KIND_LABEL) as OutboundKind[]).map((k) => (
          <option key={k} value={k}>
            {KIND_LABEL[k]}
          </option>
        ))}
      </Select>
      <ErrorBox error={create.error} />
      <div>
        <Button type="submit" disabled={create.isPending || !body.trim()} data-testid="outbound-new-submit">
          Draft update
        </Button>
      </div>
    </form>
  );
}
