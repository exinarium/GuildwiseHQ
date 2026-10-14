import {
  type CardDetailResponse,
  COMPLETION_ACTION_LABELS,
  fieldCatalogue,
  isMockField,
  type SubworkflowChildDto,
  type WorkflowDefinition,
  workflowUsesRepos,
} from '@aom/shared';
import { MoreHorizontal } from 'lucide-react';
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
  useReopenCard,
  useSpecifyCard,
} from '../api/queries/cards.ts';
import { useDecisionPolicy, useRehomeCard } from '../api/queries/members.ts';
import { AttachmentsPanel } from '../components/AttachmentsPanel.tsx';
import { BackoffBadge } from '../components/BackoffBadge.tsx';
import {
  CompletionControl,
  EditCardDialog,
  PriorityControl,
  RiskTierDialog,
} from '../components/CardEdit.tsx';
import { CardPhase } from '../components/CardPhase.tsx';
import { AskDevOpsButton } from '../components/devops/AskDevOps.tsx';
import { EvidencePanel, TestingLinks } from '../components/EvidencePanel.tsx';
import { AgentAvatar } from '../components/Face.tsx';
import { FinalizePanel } from '../components/FinalizePanel.tsx';
import { InvestigationPanel, MainSyncNote } from '../components/InvestigationPanel.tsx';
import { McpUsagePanel } from '../components/McpUsagePanel.tsx';
import { OutboundHistory } from '../components/OutboundHistory.tsx';
import { PublicationPanel } from '../components/PublicationPanel.tsx';
import { ShiftLog } from '../components/ShiftLog.tsx';
import {
  cancellableChildren,
  StartedByLine,
  SubworkflowsPanel,
  SubworkflowWaitLine,
} from '../components/SubworkflowsPanel.tsx';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  Menu,
  MenuItem,
  MenuSeparator,
  PageHeader,
  PageSkeleton,
  Panel,
  Select,
  Stepper,
  TextArea,
  useToast,
} from '../components/ui.tsx';
import { WorkabilityWarning } from '../components/WorkabilityWarning.tsx';
import { fieldLabel } from '../lib/cardForm.ts';
import { landingText } from '../lib/outcomes.ts';
import { priorityLabel } from '../lib/priority.ts';
import { stageStyle } from '../lib/stages.ts';
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

const STATUS_WORD: Record<string, string> = {
  draft: 'Draft',
  queued: 'Queued',
  claimed: 'In progress',
  blocked: 'Blocked',
  waiting: 'Waiting',
  done: 'Done',
  cancelled: 'Cancelled',
};

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
  if (q.isPending)
    return (
      <div className="mx-auto max-w-6xl">
        <PageSkeleton label="Loading card" />
      </div>
    );
  if (q.isError) {
    const err = q.error as {
      code?: string;
      status?: number;
      details?: { candidates?: AmbiguousCandidate[] };
    };
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Card" back={{ to: '/', label: 'Back to the board' }} />
        {err.status === 404 ? (
          <EmptyState
            title="Card not found"
            description={`Nothing is called ${ref}, or you do not have access to its project.`}
          />
        ) : (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        )}
        {err.code === 'ambiguous_ref' && (
          <ul data-testid="ambiguous-card-candidates" className="mt-3 flex flex-col gap-2">
            {(err.details?.candidates ?? []).map((c) => (
              <li key={c.id}>
                <Link
                  to={`/cards/${c.id}`}
                  className="block rounded-card border border-line bg-surface p-3 hover:border-control"
                >
                  <span className="font-mono text-sm text-muted">{c.ref}</span>{' '}
                  <span className="font-medium text-fg">{c.title}</span>
                  <span className="block text-sm text-subtle">in {c.projectName}</span>
                </Link>
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
  const expert = me.data?.user?.gitExpert === true;
  const [dialog, setDialog] = useState<'move' | 'cancel' | 'edit' | 'risk' | 'reopen' | null>(null);
  const [confirm, setConfirm] = useState<'release' | 'rehome' | null>(null);
  const toast = useToast();
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

  const stages = (workflow?.stages ?? []).map((st) => ({
    id: st.id,
    label: st.label,
    color: stageStyle(st.column).color,
  }));
  const active = card.status !== 'done' && card.status !== 'cancelled';
  const canRehome = permissions.canMove && !card.claimedByAgentName && active;
  const canRelease = permissions.canRelease && card.status === 'claimed';
  const canCancel = permissions.canCancel && active;
  const hasMore = canRelease || canRehome || canCancel;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        back={{
          to: `/p/${card.ref.slice(0, Math.max(0, card.ref.lastIndexOf('-')))}/board`,
          label: 'Back to the board',
        }}
        title={`${card.ref} ${card.title}`}
        eyebrow={
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded-[6px] bg-sunken px-1.5 py-0.5 font-mono text-xs font-semibold text-muted">
              {card.ref}
            </span>
            <Badge tone={statusTone(card.status)}>{STATUS_WORD[card.status] ?? card.status}</Badge>
            <Badge>{card.cardType}</Badge>
            {card.reworkRound > 0 && <Badge tone="violet">Rework {card.reworkRound}</Badge>}
            <BackoffBadge backoff={card.backoff} />
            <WorkabilityWarning
              workability={data.workability}
              projectId={card.projectId}
              className="w-full max-w-xl rounded-control border"
            />
          </div>
        }
        sub={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span data-testid="card-column" className="font-medium text-fg">
              {card.column}
            </span>
            {card.claimedByAgentName ? (
              <span className="inline-flex items-center gap-1.5">
                <AgentAvatar agentId={card.claimedByAgentId} name={card.claimedByAgentName} size={20} />
                {card.claimedByAgentName}
              </span>
            ) : (
              card.status !== 'done' && card.status !== 'cancelled' && <span>Not claimed yet</span>
            )}
          </span>
        }
        actions={
          <>
            {permissions.canSpecify && card.status === 'draft' && (
              <Button variant="primary" loading={specify.isPending} onClick={() => specify.mutate(undefined)}>
                Specify
              </Button>
            )}
            {permissions.canEdit && workflow && (
              <Button data-testid="edit-card" onClick={() => setDialog('edit')}>
                Edit
              </Button>
            )}
            {permissions.canMove && <Button onClick={() => setDialog('move')}>Move</Button>}
            {permissions.canReopen && workflow && (
              <Button data-testid="reopen-card" onClick={() => setDialog('reopen')}>
                Reopen
              </Button>
            )}
            <AskDevOpsButton
              variant="quiet"
              label="Ask DevOps"
              request={{
                origin: 'card',
                projectId: card.projectId,
                cardId: card.id,
                cardLabel: `${card.ref} ${card.title}`,
                ...(data.workability?.ok === false && data.workability.reason
                  ? { errorText: data.workability.reason }
                  : {}),
              }}
            />
            {permissions.canReleaseBackoff && (
              <Button
                data-testid="release-backoff"
                loading={releaseBackoff.isPending}
                title="Retry the card now instead of waiting for the back-off to end"
                onClick={() => releaseBackoff.mutate(undefined)}
              >
                Release back-off
              </Button>
            )}
            {hasMore && (
              <Menu label="More actions" trigger={<MoreHorizontal aria-hidden="true" className="size-4" />}>
                {canRelease && (
                  <MenuItem
                    description="Let another agent claim it. The current attempt stops."
                    onSelect={() => setConfirm('release')}
                  >
                    Release
                  </MenuItem>
                )}
                {canRehome && (
                  <MenuItem
                    description="Forget its workstation and worktree: the stage restarts from the base branch."
                    onSelect={() => setConfirm('rehome')}
                  >
                    Re-home
                  </MenuItem>
                )}
                {canCancel && (
                  <>
                    {(canRelease || canRehome) && <MenuSeparator />}
                    <MenuItem danger onSelect={() => setDialog('cancel')}>
                      Cancel card
                    </MenuItem>
                  </>
                )}
              </Menu>
            )}
          </>
        }
      />
      {stages.length > 0 && card.status !== 'cancelled' && (
        <div className="mb-5 rounded-card border border-line bg-surface px-4 py-3">
          <Stepper steps={stages} currentId={card.stage} label="Workflow stages" />
        </div>
      )}
      {missing.length > 0 && (
        <Callout tone="danger" role="alert" className="mb-4">
          Cannot specify yet. Missing:{' '}
          {missing.map((m) => (workflow ? fieldLabel(workflow, m) : m)).join(', ')}
        </Callout>
      )}
      {!missing.length && (
        <ErrorBox
          error={specify.error ?? release.error ?? releaseBackoff.error ?? rehome.error ?? policy.error}
        />
      )}
      {blockers.length > 0 && (
        <Callout
          tone="warning"
          role="status"
          data-testid="card-blockers"
          className="mb-4"
          title="Waiting for your answer"
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
        </Callout>
      )}

      <SubworkflowWaitLine data={data.subworkflows} />
      <StartedByLine data={data.subworkflows} />
      {data.testing && (
        <TestingLinks
          testing={data.testing}
          status={card.status}
          hideWaiting={data.subworkflows?.children.some((c) => c.state === 'open') ?? false}
        />
      )}
      <MainSyncNote card={card} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {currentShift && currentShift.status !== 'ended' && (
            <Panel
              title={
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="size-2 animate-pulse-soft rounded-full bg-accent ring-1 ring-fg/20"
                  />
                  Live shift{currentShift.agentName ? ` · ${currentShift.agentName}` : ''}
                  <span className="text-sm font-normal text-subtle">{currentShift.stage}</span>
                </span>
              }
            >
              <ShiftLog key={currentShift.id} shift={currentShift} />
            </Panel>
          )}
          <McpUsagePanel usage={data.mcpUsage ?? []} />
          {data.publication && <PublicationPanel publication={data.publication} />}
          <InvestigationPanel card={card} />
          {keys.length > 0 && (
            <Panel title="What to build" data-testid="card-spec">
              <dl className="flex flex-col gap-4 text-base">
                {keys.map((k) => (
                  <div key={k}>
                    <dt className="text-sm font-semibold text-fg">{catalogue[k]?.label ?? k}</dt>
                    <dd className="mt-1 text-muted">{renderValue(card.fields[k])}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          )}
          <AttachmentsPanel
            cardId={card.id}
            attachments={data.attachments ?? []}
            canAttach={permissions.canAttach ?? false}
          />
          <SubworkflowsPanel data={data.subworkflows} />
          <ThreadPanel cardId={card.id} thread={thread} canComment={permissions.canComment} />
          {data.testing && (
            <FinalizePanel
              cardId={card.id}
              finalize={data.testing.finalize}
              completionAction={card.effectiveCompletionAction}
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
          <Panel title={`Handoffs (${handoffs.length})`}>
            {handoffs.length === 0 && <p className="text-sm text-subtle">No handoffs yet.</p>}
            <ol className="flex flex-col gap-3" data-testid="handoffs">
              {handoffs.map((h) => (
                <li
                  key={h.id}
                  data-testid="handoff"
                  data-stage={h.stage}
                  data-outcome={h.outcome}
                  className="rounded-control border border-line p-3 text-base"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
                    {h.agentName && <AgentAvatar agentId={h.agentId} name={h.agentName} size={18} />}
                    <span className="font-medium text-muted">{h.agentName ?? 'system'}</span>
                    <Badge tone={h.outcome === 'changes' || h.outcome === 'fail' ? 'red' : 'green'}>
                      {h.stage}: {h.outcome}
                    </Badge>
                    <span>{formatDateTime(h.createdAt)}</span>
                  </div>
                  {h.note && <p className="mt-2 whitespace-pre-wrap text-fg">{h.note}</p>}
                  <HandoffData data={h.data} />
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
          <Panel title="Details">
            <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-1">
              <Meta k="Stage" v={card.stage} />
              {(!workflow || workflowUsesRepos(workflow)) && (
                <div>
                  <dt className="text-xs font-medium text-subtle">Risk tier</dt>
                  <dd className="flex flex-wrap items-center gap-1.5 text-fg" data-testid="risk-tier">
                    <span>{card.riskTier ?? 'not set'}</span>
                    {card.riskTierOverridden && <Badge tone="violet">override</Badge>}
                    {permissions.canSetRisk && (
                      <button
                        type="button"
                        data-testid="set-risk"
                        className="text-xs text-brand-text underline"
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
                  {permissions.canEditCompletion ? (
                    <CompletionControl card={card} />
                  ) : expert ? (
                    <Meta
                      k="Completion action"
                      v={
                        card.effectiveCompletionAction
                          ? `${COMPLETION_ACTION_LABELS[card.effectiveCompletionAction].label}${card.completionActionSource === 'project' ? ' (project default)' : ''}`
                          : 'not set'
                      }
                    />
                  ) : (
                    <Meta k="Where it lands" v={landingText(card)} />
                  )}
                  <Meta k="Docs needed" v={card.docsNeeded ? 'yes' : 'no'} />
                  {card.designNeeded && (
                    <Meta
                      k="Investigate & design"
                      v={card.investigationOnly ? 'investigation only' : 'yes'}
                    />
                  )}
                </>
              )}
              {expert && card.branchName && <Meta k="Branch" v={card.branchName} mono />}
              {permissions.canEditPriority ? (
                <PriorityControl card={card} />
              ) : (
                <Meta k="Priority" v={priorityLabel(card.priority)} />
              )}
              {(data.phase || permissions.canSetPhase) && (
                <div className="sm:col-span-2 lg:col-span-1">
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
                <dt className="text-xs font-medium text-subtle">Who answers its questions</dt>
                <dd className="text-fg">
                  {permissions.canMove ? (
                    <select
                      aria-label="Decision policy"
                      data-testid="decision-policy"
                      className="mt-1 h-9 w-full rounded-control border border-control bg-surface px-2 text-sm text-fg"
                      value={card.decisionPolicy}
                      disabled={policy.isPending}
                      onChange={(e) =>
                        policy.mutate(
                          { policy: e.target.value as 'owner_only' | 'any_manager' },
                          { onSuccess: () => toast.success('Decision policy updated') },
                        )
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
          </Panel>
          <Panel title="Timeline">
            <ol className="flex flex-col gap-3 text-sm" data-testid="timeline">
              {timeline.map((t) =>
                t.entry === 'transition' ? (
                  <li key={`t${t.id}`} className="flex flex-col border-l-2 border-line pl-3">
                    <span className="text-fg">
                      <span className="font-medium">{t.fromStage ?? 'new'}</span> →{' '}
                      <span className="font-medium">{t.toStage}</span>{' '}
                      <span className="text-xs text-subtle">({t.toStatus})</span>
                    </span>
                    <span className="text-xs text-subtle">
                      {t.reason} · {formatDateTime(t.at)}
                    </span>
                  </li>
                ) : (
                  <li
                    key={`a${t.id}`}
                    className="flex flex-col border-l-2 border-brand/40 pl-3"
                    data-testid="timeline-activity"
                    data-kind={t.kind}
                  >
                    <span className="text-fg">{t.summary}</span>
                    {t.reason && <span className="text-xs text-muted">Reason: {t.reason}</span>}
                    <span className="text-xs text-subtle">
                      {t.actorName ? `${t.actorName} · ` : ''}
                      {formatDateTime(t.at)}
                    </span>
                  </li>
                ),
              )}
            </ol>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        open={confirm === 'release'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Release ${card.ref}?`}
        description="The agent's claim ends so another agent can take the card. Work in progress is not kept."
        confirmLabel="Release card"
        pending={release.isPending}
        onConfirm={() =>
          release.mutate(undefined, {
            onSuccess: () => {
              setConfirm(null);
              toast.success(`${card.ref} released`);
            },
            onError: () => setConfirm(null),
          })
        }
      />
      <ConfirmDialog
        open={confirm === 'rehome'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Re-home ${card.ref}?`}
        description="The card forgets its workstation and worktree. The stage restarts from the base branch."
        confirmLabel="Re-home card"
        pending={rehome.isPending}
        onConfirm={() =>
          rehome.mutate(undefined, {
            onSuccess: () => {
              setConfirm(null);
              toast.success(`${card.ref} re-homed`);
            },
            onError: () => setConfirm(null),
          })
        }
      />
      {workflow && (
        <MoveDialog
          open={dialog === 'move'}
          onOpenChange={(o) => !o && setDialog(null)}
          cardId={card.id}
          workflow={workflow}
          current={card.stage}
        />
      )}
      {workflow && permissions.canReopen && (
        <ReopenDialog
          open={dialog === 'reopen'}
          onOpenChange={(o) => !o && setDialog(null)}
          cardId={card.id}
          workflow={workflow}
          branchName={card.branchName}
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
      <CancelDialog
        open={dialog === 'cancel'}
        onOpenChange={(o) => !o && setDialog(null)}
        cardId={card.id}
        waitingOn={cancellableChildren(card.status, data.subworkflows)}
      />
    </div>
  );
}

function Meta({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-subtle">{k}</dt>
      <dd className={mono ? 'font-mono text-xs break-all text-fg' : 'text-fg'}>{v}</dd>
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
        <span key={m} className="text-subtle">
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
      <h2 className="mb-3 text-lg font-semibold text-fg">Thread</h2>
      <ul className="flex flex-col gap-2" data-testid="thread">
        {thread.length === 0 && <li className="text-sm text-subtle">No messages yet.</li>}
        {thread.map((m) => (
          <li key={m.id} className="text-sm">
            <div className="flex items-center gap-1.5 text-xs text-subtle">
              {m.authorName &&
                (m.authorKind === 'agent' ? (
                  <AgentAvatar agentId={m.authorAgentId} name={m.authorName} size={16} />
                ) : (
                  <Avatar name={m.authorName} size={16} />
                ))}
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

function ReopenDialog({
  open,
  onOpenChange,
  cardId,
  workflow,
  branchName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cardId: string;
  workflow: WorkflowDefinition;
  branchName: string | null;
}) {
  const reopen = useReopenCard(cardId);
  const toast = useToast();
  const stages = workflow.stages.filter((s) => s.kind === 'agent' || s.kind === 'manual');
  const [toStage, setToStage] = useState((stages.find((s) => s.kind === 'agent') ?? stages[0])?.id ?? '');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return setErr('A reason is required');
    setErr('');
    reopen.mutate(
      { toStage, reason: reason.trim() },
      {
        onSuccess: () => {
          setReason('');
          onOpenChange(false);
          toast.success('Card reopened');
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reopen card"
      description={`The card goes back to work in the stage you pick. Its branch${branchName ? ` (${branchName})` : ''} is kept and the next shift continues on it; an open pull request is kept and reused when the card is finalized again.`}
    >
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Select label="Reopen into" value={toStage} onChange={(e) => setToStage(e.target.value)}>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} error={err} />
        <ErrorBox error={reopen.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button type="submit" variant="primary" disabled={reopen.isPending}>
            Reopen card
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function CancelDialog({
  open,
  onOpenChange,
  cardId,
  waitingOn = [],
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cardId: string;
  /** Open sub-workflow children this card waits on and the viewer may cancel. */
  waitingOn?: SubworkflowChildDto[];
}) {
  const cancel = useCancelCard(cardId);
  const [reason, setReason] = useState('');
  const [alsoChildren, setAlsoChildren] = useState(false);
  const [err, setErr] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return setErr('A reason is required');
    setErr('');
    cancel.mutate(
      { reason: reason.trim(), alsoCancelChildren: waitingOn.length > 0 && alsoChildren },
      { onSuccess: () => onOpenChange(false) },
    );
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
        {waitingOn.length > 0 && (
          <label className="inline-flex items-start gap-2 text-sm" data-testid="cancel-children">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={alsoChildren}
              onChange={(e) => setAlsoChildren(e.target.checked)}
            />
            <span>
              Also cancel the card{waitingOn.length > 1 ? 's' : ''} it is waiting for:{' '}
              {waitingOn.map((c) => `${c.child.ref}${c.child.title ? ` (${c.child.title})` : ''}`).join(', ')}
              <span className="block text-xs text-subtle">
                Left unticked, {waitingOn.length > 1 ? 'they keep' : 'it keeps'} running on its own.
              </span>
            </span>
          </label>
        )}
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
