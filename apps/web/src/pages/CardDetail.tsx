import {
  type CardDetailResponse,
  fieldCatalogue,
  isMockField,
  type WorkflowDefinition,
  workflowUsesRepos,
} from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useWorkflows } from '../api/queries/agents.ts';
import { useMe } from '../api/queries/auth.ts';
import {
  missingFromError,
  useCancelCard,
  useCard,
  useComment,
  useMoveCard,
  useReleaseBackoff,
  useReleaseCard,
  useSpecifyCard,
} from '../api/queries/cards.ts';
import { useDecisionPolicy, useRehomeCard } from '../api/queries/members.ts';
import { BackoffBadge } from '../components/BackoffBadge.tsx';
import { EditCardDialog, RiskTierDialog } from '../components/CardEdit.tsx';
import { CardPhase } from '../components/CardPhase.tsx';
import { EvidencePanel, TestingLinks } from '../components/EvidencePanel.tsx';
import { FinalizePanel } from '../components/FinalizePanel.tsx';
import { OutboundHistory } from '../components/OutboundHistory.tsx';
import { PublicationPanel } from '../components/PublicationPanel.tsx';
import { ShiftLog } from '../components/ShiftLog.tsx';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  ErrorBox,
  PageHeader,
  Panel,
  Select,
  Spinner,
  TextArea,
} from '../components/ui.tsx';
import { WorkabilityWarning } from '../components/WorkabilityWarning.tsx';
import { fieldLabel } from '../lib/cardForm.ts';
import { formatDateTime } from '../lib/time.ts';

function renderValue(v: unknown) {
  if (Array.isArray(v)) {
    return (
      <ul className="list-disc pl-5">
        {v.map((x, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static display list
          <li key={i}>{typeof x === 'string' ? x : JSON.stringify(x)}</li>
        ))}
      </ul>
    );
  }
  if (typeof v === 'object' && v !== null) {
    return <pre className="overflow-x-auto font-mono text-xs">{JSON.stringify(v, null, 2)}</pre>;
  }
  return <p className="whitespace-pre-wrap">{String(v)}</p>;
}

function statusTone(status: string) {
  if (status === 'blocked') return 'red' as const;
  if (status === 'claimed') return 'blue' as const;
  if (status === 'done') return 'green' as const;
  if (status === 'waiting') return 'amber' as const;
  return 'neutral' as const;
}

interface AmbiguousCandidate {
  id: string;
  ref: string;
  title: string;
  projectName: string;
}

export function CardDetail() {
  const { ref = '' } = useParams();
  const q = useCard(ref);
  const workflows = useWorkflows(q.data?.card.projectId);
  if (q.isPending) return <Spinner label="Loading card" />;
  if (q.isError) {
    const err = q.error as { code?: string; details?: { candidates?: AmbiguousCandidate[] } };
    return (
      <div>
        <PageHeader title="Card" />
        <ErrorBox error={q.error} />
        {err.code === 'ambiguous_ref' && (
          <ul data-testid="ambiguous-card-candidates" className="mt-2 list-disc pl-5 text-sm">
            {(err.details?.candidates ?? []).map((c) => (
              <li key={c.id}>
                <Link to={`/cards/${c.id}`} className="underline">
                  {c.ref} {c.title}
                </Link>{' '}
                in {c.projectName}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const candidates = (workflows.data ?? [])
    .map((w) => w.definition)
    .filter((d) => d.key === q.data.card.workflowKey)
    .sort((x, y) => y.version - x.version);
  const wf = candidates.find((d) => d.version === q.data.card.workflowVersion) ?? candidates[0];
  return <CardDetailView data={q.data} workflow={wf} />;
}

export function CardDetailView({
  data,
  workflow,
}: {
  data: CardDetailResponse;
  workflow: WorkflowDefinition | undefined;
}) {
  const { card, handoffs, transitions, activity, thread, currentShift, permissions, blockers } = data;
  const specify = useSpecifyCard(card.id);
  const release = useReleaseCard(card.id);
  const releaseBackoff = useReleaseBackoff(card.id);
  const policy = useDecisionPolicy(card.id);
  const rehome = useRehomeCard(card.id);
  const me = useMe();
  const [dialog, setDialog] = useState<'move' | 'cancel' | 'edit' | 'risk' | null>(null);
  const mockUi = me.data?.features?.mockUi ?? false;
  const missing = missingFromError(specify.error);
  const catalogue = workflow ? fieldCatalogue(workflow.fieldSet, workflow.customFields) : {};
  // Mock-runtime fields (Mock script, ...) are shown only in mock mode.
  const keys = Object.keys(card.fields).filter((k) => mockUi || !isMockField(k));
  const timeline = [
    ...transitions.map((t) => ({ ...t, sort: t.at, tie: t.id, entry: 'transition' as const })),
    ...activity.map((a) => ({ ...a, sort: a.at, tie: a.id, entry: 'activity' as const })),
  ].sort(
    (a, b) =>
      a.sort.localeCompare(b.sort) ||
      (a.entry === b.entry ? a.tie - b.tie : a.entry === 'transition' ? -1 : 1),
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={`${card.ref} ${card.title}`}
        sub={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={statusTone(card.status)}>{card.status}</Badge>
            <span data-testid="card-column">{card.column}</span>
            <span>· {card.cardType}</span>
            {card.reworkRound > 0 && <Badge tone="violet">Rework {card.reworkRound}</Badge>}
            <BackoffBadge backoff={card.backoff} />
            <WorkabilityWarning workability={data.workability} projectId={card.projectId} />
            {card.claimedByAgentName && (
              <span className="inline-flex items-center gap-1">
                <Avatar name={card.claimedByAgentName} size={18} />
                {card.claimedByAgentName}
              </span>
            )}
          </span>
        }
        actions={
          <>
            {permissions.canSpecify && card.status === 'draft' && (
              <Button
                variant="primary"
                disabled={specify.isPending}
                onClick={() => specify.mutate(undefined)}
              >
                Specify
              </Button>
            )}
            {permissions.canEdit && workflow && (
              <Button data-testid="edit-card" onClick={() => setDialog('edit')}>
                Edit
              </Button>
            )}
            {permissions.canMove && <Button onClick={() => setDialog('move')}>Move</Button>}
            {permissions.canRelease && card.status === 'claimed' && (
              <Button disabled={release.isPending} onClick={() => release.mutate(undefined)}>
                Release
              </Button>
            )}
            {permissions.canReleaseBackoff && (
              <Button
                data-testid="release-backoff"
                disabled={releaseBackoff.isPending}
                title="Retry the card now instead of waiting for the back-off to end"
                onClick={() => releaseBackoff.mutate(undefined)}
              >
                Release back-off
              </Button>
            )}
            {permissions.canMove &&
              !card.claimedByAgentName &&
              card.status !== 'done' &&
              card.status !== 'cancelled' && (
                <Button
                  disabled={rehome.isPending}
                  title="Forget this card's workstation and worktree: the stage restarts from the base branch"
                  onClick={() => rehome.mutate()}
                >
                  Re-home
                </Button>
              )}
            {permissions.canCancel && card.status !== 'cancelled' && card.status !== 'done' && (
              <Button variant="danger" onClick={() => setDialog('cancel')}>
                Cancel card
              </Button>
            )}
          </>
        }
      />
      {missing.length > 0 && (
        <p role="alert" className="mb-3 text-sm font-medium text-red-600 dark:text-red-400">
          Cannot specify yet. Missing:{' '}
          {missing.map((m) => (workflow ? fieldLabel(workflow, m) : m)).join(', ')}
        </p>
      )}
      {!missing.length && (
        <ErrorBox
          error={specify.error ?? release.error ?? releaseBackoff.error ?? rehome.error ?? policy.error}
        />
      )}
      {blockers.length > 0 && (
        <div
          role="status"
          data-testid="card-blockers"
          className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          Blocked by{' '}
          {blockers.map((b, i) => (
            <span key={b.deskItemId}>
              {i > 0 && ', '}
              <Link to={`/desk#desk-item-${b.deskItemId}`} className="font-medium underline">
                {b.title}
              </Link>
            </span>
          ))}
          . Answer it on the desk to put this card back in the queue.
        </div>
      )}

      {data.testing && <TestingLinks testing={data.testing} status={card.status} />}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          {currentShift && currentShift.status !== 'ended' && (
            <Panel>
              <h2 className="mb-2 text-sm font-semibold">
                Live shift{currentShift.agentName ? ` · ${currentShift.agentName}` : ''}
                <span className="ml-2 font-normal text-zinc-500">{currentShift.stage}</span>
              </h2>
              <ShiftLog key={currentShift.id} shift={currentShift} />
            </Panel>
          )}
          {data.publication && <PublicationPanel publication={data.publication} />}
          <Panel>
            <h2 className="mb-2 text-sm font-semibold">Details</h2>
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
              <Meta k="Stage" v={card.stage} />
              {(!workflow || workflowUsesRepos(workflow)) && (
                <div>
                  <dt className="text-xs font-medium text-zinc-500">Risk tier</dt>
                  <dd className="flex flex-wrap items-center gap-1.5" data-testid="risk-tier">
                    <span>{card.riskTier ?? 'not set'}</span>
                    {card.riskTierOverridden && <Badge tone="violet">override</Badge>}
                    {permissions.canSetRisk && (
                      <button
                        type="button"
                        data-testid="set-risk"
                        className="text-xs underline"
                        onClick={() => setDialog('risk')}
                      >
                        Change
                      </button>
                    )}
                  </dd>
                </div>
              )}
              {(!workflow || workflowUsesRepos(workflow)) && (
                <>
                  <Meta k="Completion action" v={card.completionAction ?? 'not set'} />
                  <Meta k="Docs needed" v={card.docsNeeded ? 'yes' : 'no'} />
                </>
              )}
              {card.branchName && <Meta k="Branch" v={card.branchName} mono />}
              <Meta k="Priority" v={String(card.priority)} />
              {(data.phase || permissions.canSetPhase) && (
                <div className="sm:col-span-2">
                  <dt className="sr-only">Phase</dt>
                  <dd>
                    <CardPhase
                      cardId={card.id}
                      projectId={card.projectId}
                      phase={data.phase ?? null}
                      canSet={!!permissions.canSetPhase}
                      status={card.status}
                    />
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs font-medium text-zinc-500">Who answers its questions</dt>
                <dd>
                  {permissions.canMove ? (
                    <select
                      aria-label="Decision policy"
                      data-testid="decision-policy"
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      value={card.decisionPolicy}
                      disabled={policy.isPending}
                      onChange={(e) =>
                        policy.mutate({ policy: e.target.value as 'owner_only' | 'any_manager' })
                      }
                    >
                      <option value="owner_only">Only the card owner</option>
                      <option value="any_manager">Any manager of the project</option>
                    </select>
                  ) : (
                    <span data-testid="decision-policy">
                      {card.decisionPolicy === 'any_manager'
                        ? 'Any manager of the project'
                        : 'Only the card owner'}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
            {keys.length > 0 && (
              <dl className="mt-3 flex flex-col gap-3 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-800">
                {keys.map((k) => (
                  <div key={k}>
                    <dt className="text-xs font-medium text-zinc-500">{catalogue[k]?.label ?? k}</dt>
                    <dd className="mt-0.5">{renderValue(card.fields[k])}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Panel>
          {data.testing && (
            <FinalizePanel
              cardId={card.id}
              finalize={data.testing.finalize}
              completionAction={card.completionAction ?? null}
              canAct={permissions.canMove}
            />
          )}
          {data.testing && <EvidencePanel testing={data.testing} handoffs={handoffs} />}
          <OutboundHistory
            cardId={card.id}
            cardRef={card.ref}
            ticket={typeof card.fields.externalRef === 'string' ? card.fields.externalRef : undefined}
            isOwner={me.data?.user.id === card.ownerUserId}
            canDraft={permissions.canMove}
          />
          <Panel>
            <h2 className="mb-2 text-sm font-semibold">Handoffs ({handoffs.length})</h2>
            {handoffs.length === 0 && <p className="text-sm text-zinc-500">No handoffs yet.</p>}
            <ol className="flex flex-col gap-2" data-testid="handoffs">
              {handoffs.map((h) => (
                <li
                  key={h.id}
                  data-testid="handoff"
                  data-stage={h.stage}
                  data-outcome={h.outcome}
                  className="rounded-md border border-zinc-200 p-2 text-sm dark:border-zinc-800"
                >
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                    {h.agentName && <Avatar name={h.agentName} size={18} />}
                    <span>{h.agentName ?? 'system'}</span>
                    <Badge tone={h.outcome === 'changes' || h.outcome === 'fail' ? 'red' : 'green'}>
                      {h.stage}: {h.outcome}
                    </Badge>
                    <span>{formatDateTime(h.createdAt)}</span>
                  </div>
                  {h.note && <p className="mt-1 whitespace-pre-wrap">{h.note}</p>}
                  <HandoffData data={h.data} />
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <Panel>
            <h2 className="mb-2 text-sm font-semibold">Timeline</h2>
            <ol className="flex flex-col gap-1.5 text-sm" data-testid="timeline">
              {timeline.map((t) =>
                t.entry === 'transition' ? (
                  <li key={`t${t.id}`} className="flex flex-col">
                    <span>
                      <span className="font-medium">{t.fromStage ?? 'new'}</span> →{' '}
                      <span className="font-medium">{t.toStage}</span>{' '}
                      <span className="text-xs text-zinc-500">({t.toStatus})</span>
                    </span>
                    <span className="text-xs text-zinc-500">
                      {t.reason} · {formatDateTime(t.at)}
                    </span>
                  </li>
                ) : (
                  <li
                    key={`a${t.id}`}
                    className="flex flex-col"
                    data-testid="timeline-activity"
                    data-kind={t.kind}
                  >
                    <span>{t.summary}</span>
                    {t.reason && <span className="text-xs">Reason: {t.reason}</span>}
                    <span className="text-xs text-zinc-500">
                      {t.actorName ? `${t.actorName} · ` : ''}
                      {formatDateTime(t.at)}
                    </span>
                  </li>
                ),
              )}
            </ol>
          </Panel>
          <ThreadPanel cardId={card.id} thread={thread} canComment={permissions.canComment} />
        </div>
      </div>

      {workflow && (
        <MoveDialog
          open={dialog === 'move'}
          onOpenChange={(o) => !o && setDialog(null)}
          cardId={card.id}
          workflow={workflow}
          current={card.stage}
        />
      )}
      {workflow && permissions.canEdit && dialog === 'edit' && (
        <EditCardDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          card={card}
          workflow={workflow}
          mockUi={mockUi}
        />
      )}
      {permissions.canSetRisk && dialog === 'risk' && (
        <RiskTierDialog open onOpenChange={(o) => !o && setDialog(null)} card={card} />
      )}
      <CancelDialog open={dialog === 'cancel'} onOpenChange={(o) => !o && setDialog(null)} cardId={card.id} />
    </div>
  );
}

function Meta({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-zinc-500">{k}</dt>
      <dd className={mono ? 'font-mono text-xs break-all' : ''}>{v}</dd>
    </div>
  );
}

function HandoffData({ data }: { data: Record<string, unknown> }) {
  const reasons = Array.isArray(data.reasons) ? (data.reasons as string[]) : [];
  const missed = Array.isArray(data.criteriaMissed) ? (data.criteriaMissed as string[]) : [];
  const score = typeof data.score === 'number' ? data.score : null;
  if (!reasons.length && !missed.length && score === null) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs" data-testid="handoff-review">
      {score !== null && <Badge>Score {score}/5</Badge>}
      {reasons.map((r) => (
        <Badge key={r} tone="red">
          {r.replaceAll('_', ' ')}
        </Badge>
      ))}
      {missed.map((m) => (
        <span key={m} className="text-zinc-500">
          Missed: {m}
        </span>
      ))}
    </div>
  );
}

function ThreadPanel({
  cardId,
  thread,
  canComment,
}: {
  cardId: string;
  thread: CardDetailResponse['thread'];
  canComment: boolean;
}) {
  const comment = useComment(cardId);
  const [body, setBody] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    comment.mutate(body.trim(), { onSuccess: () => setBody('') });
  };
  return (
    <Panel>
      <h2 className="mb-2 text-sm font-semibold">Thread</h2>
      <ul className="flex flex-col gap-2" data-testid="thread">
        {thread.length === 0 && <li className="text-sm text-zinc-500">No messages yet.</li>}
        {thread.map((m) => (
          <li key={m.id} className="text-sm">
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              {m.authorName && <Avatar name={m.authorName} size={16} />}
              <span className="font-medium">{m.authorName ?? m.authorKind}</span>
              <Badge>{m.kind}</Badge>
              <span>{formatDateTime(m.createdAt)}</span>
            </div>
            <p className="mt-0.5 whitespace-pre-wrap">{m.body}</p>
          </li>
        ))}
      </ul>
      {canComment && (
        <form onSubmit={submit} className="mt-3 flex flex-col gap-2" aria-label="Add comment">
          <TextArea label="Comment" value={body} onChange={(e) => setBody(e.target.value)} />
          <ErrorBox error={comment.error} />
          <Button
            type="submit"
            variant="primary"
            disabled={!body.trim() || comment.isPending}
            className="self-start"
          >
            Post comment
          </Button>
        </form>
      )}
    </Panel>
  );
}

function MoveDialog({
  open,
  onOpenChange,
  cardId,
  workflow,
  current,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cardId: string;
  workflow: WorkflowDefinition;
  current: string;
}) {
  const move = useMoveCard(cardId);
  const [toStage, setToStage] = useState(current);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return setErr('A reason is required');
    setErr('');
    move.mutate(
      { toStage, reason: reason.trim() },
      {
        onSuccess: () => {
          setReason('');
          onOpenChange(false);
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Move card"
      description="Override the workflow and move this card to another stage."
    >
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Select label="Target stage" value={toStage} onChange={(e) => setToStage(e.target.value)}>
          {workflow.stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} error={err} />
        <ErrorBox error={move.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button type="submit" variant="primary" disabled={move.isPending}>
            Move card
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CancelDialog({
  open,
  onOpenChange,
  cardId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cardId: string;
}) {
  const cancel = useCancelCard(cardId);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return setErr('A reason is required');
    setErr('');
    cancel.mutate(reason.trim(), { onSuccess: () => onOpenChange(false) });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Cancel card"
      description="The card leaves the board. Any active claim is released."
    >
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} error={err} />
        <ErrorBox error={cancel.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Keep card</Button>
          <Button type="submit" variant="danger" disabled={cancel.isPending}>
            Confirm cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
