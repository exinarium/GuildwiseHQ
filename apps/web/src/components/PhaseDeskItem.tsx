import type { DeskItemDto, FollowupSpec } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useDismissDeskItem, useResolveDeskItem } from '../api/queries/desk.ts';
import { useDeployTargets, useReopenPhase, useSetPhaseFollowups } from '../api/queries/phases.ts';
import { OUTCOME_LABEL, phasePath, specOf } from '../lib/phases.ts';
import { FollowupEditor, followupProblems } from './FollowupEditor.tsx';
import { Button, Dialog, ErrorBox, TextArea } from './ui.tsx';

/**
 * The actions and live detail of the phase desk items: the BA's proposal (confirm or reject), "phase done" (approve the
 * follow-ups, edit them first, reject, or reopen the phase) and the results notice (acknowledge). Any member may act.
 */
export function PhaseDeskItem({ item }: { item: DeskItemDto }) {
  const phase = item.phase;
  const resolve = useResolveDeskItem();
  const dismiss = useDismissDeskItem();
  const targets = useDeployTargets(item.projectId ?? undefined);
  const save = useSetPhaseFollowups(phase?.phaseId ?? '');
  const reopen = useReopenPhase(phase?.phaseId ?? '');
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState<FollowupSpec[] | null>(null);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!phase) return <p className="mt-2 text-sm text-subtle">This phase is gone.</p>;
  const t = targets.data ?? [];
  const specs = phase.followups.map(specOf);
  const n = phase.followups.length;
  const sub = item.subkind;
  const act = (resolution: 'approved' | 'rejected' | 'acknowledged', note?: string) =>
    resolve.mutate({ id: item.id, body: { resolution, ...(note ? { note } : {}) } });

  return (
    <div className="mt-2 flex flex-col gap-3" data-testid="phase-desk-item">
      <p className="text-sm">
        <Link to={phasePath(phase.ref)} className="font-medium underline" data-testid="phase-link">
          {phase.ref} {phase.name}
        </Link>
      </p>

      {(sub === 'phase_proposal' || sub === 'phase_done') && phase.members.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold">Cards</h3>
          <ul className="text-sm" data-testid="phase-cards">
            {phase.members.map((m) => (
              <li key={m.cardId}>
                <Link to={`/cards/${m.cardId}`} className="underline">
                  {m.ref}
                </Link>{' '}
                {m.title}
                <span className="text-xs text-subtle">
                  {' '}
                  · {m.outcome ? OUTCOME_LABEL[m.outcome] : m.status}
                  {m.resultRef?.mergeCommit ? ` ${m.resultRef.mergeCommit.slice(0, 10)}` : ''}
                  {m.resultRef?.prUrl ? ` ${m.resultRef.prUrl}` : ''}
                  {m.assignment === 'proposed' ? ' · proposed' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sub === 'phase_done' && phase.outstanding.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold">Outstanding</h3>
          <ul className="list-disc pl-5 text-sm" data-testid="phase-outstanding">
            {phase.outstanding.map((o) => (
              <li key={o.text}>{o.text}</li>
            ))}
          </ul>
        </div>
      )}

      {(sub === 'phase_proposal' || sub === 'phase_done') && (
        <div>
          <h3 className="text-xs font-semibold">
            Follow-ups{sub === 'phase_done' ? ' (run in this order after you approve)' : ''}
          </h3>
          <FollowupEditor value={specs} targets={t} readOnly details={phase.followups} />
        </div>
      )}

      {sub === 'phase_results' && (
        <FollowupEditor value={specs} targets={t} readOnly details={phase.followups} />
      )}

      <ErrorBox error={resolve.error ?? dismiss.error ?? reopen.error} />
      <div className="flex flex-wrap gap-2">
        {sub === 'phase_proposal' && (
          <>
            <Button
              variant="primary"
              data-testid="phase-confirm"
              disabled={resolve.isPending}
              onClick={() => act('approved')}
            >
              Confirm phase
            </Button>
            <Button data-testid="phase-reject" disabled={resolve.isPending} onClick={() => act('rejected')}>
              Reject
            </Button>
            <Link to={phasePath(phase.ref)} className="inline-flex min-h-8 items-center text-sm underline">
              Edit the phase first
            </Link>
          </>
        )}
        {sub === 'phase_done' && (
          <>
            <Button
              variant="primary"
              data-testid="phase-approve"
              disabled={resolve.isPending || editOpen}
              onClick={() => act(item.kind === 'alert' ? 'acknowledged' : 'approved')}
            >
              {item.kind === 'alert' ? 'Acknowledge' : n === 1 ? 'Approve the follow-up' : `Approve all ${n}`}
            </Button>
            {item.kind !== 'alert' && (
              <Button data-testid="phase-reject" disabled={resolve.isPending} onClick={() => act('rejected')}>
                Reject
              </Button>
            )}
            {phase.canEditFollowups && (
              <Button
                data-testid="phase-edit-followups"
                onClick={() => {
                  setDraft(null);
                  setEditOpen(true);
                }}
              >
                Edit follow-ups
              </Button>
            )}
            <Button data-testid="phase-reopen" onClick={() => setReopenOpen(true)}>
              Reopen phase
            </Button>
          </>
        )}
        {sub === 'phase_results' && (
          <Button
            variant="primary"
            data-testid="phase-ack"
            disabled={resolve.isPending}
            onClick={() => act('acknowledged')}
          >
            Acknowledge
          </Button>
        )}
        <Button disabled={dismiss.isPending} onClick={() => dismiss.mutate(item.id)}>
          Dismiss
        </Button>
      </div>

      <Dialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title="Edit follow-ups"
        description="They are saved before you approve."
      >
        <div className="flex flex-col gap-3" data-testid="edit-followups-dialog">
          <FollowupEditor value={draft ?? specs} onChange={setDraft} targets={t} />
          <ErrorBox error={save.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              data-testid="save-followups"
              disabled={save.isPending || draft === null || followupProblems(draft, t).length > 0}
              onClick={() => draft && save.mutate(draft, { onSuccess: () => setEditOpen(false) })}
            >
              Save
            </Button>
          </div>
        </div>
      </Dialog>
      <Dialog
        open={reopenOpen}
        onOpenChange={setReopenOpen}
        title="Reopen the phase"
        description="It waits for its cards again; nothing runs."
      >
        <div className="flex flex-col gap-3">
          <TextArea label="Why" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setReopenOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              data-testid="phase-reopen-confirm"
              disabled={!reason.trim() || reopen.isPending}
              onClick={() => reopen.mutate(reason.trim(), { onSuccess: () => setReopenOpen(false) })}
            >
              Reopen
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
