import type { AnswerQuestionRequest, ResolveDiscoveryProposalRequest } from '@aom/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Compass, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useThreadMessages } from '../api/queries/chats.ts';
import {
  useAnswerQuestion,
  useContinueDiscovery,
  useDiscovery,
  useDiscoveryTime,
  usePauseDiscovery,
  useResolveProposal,
  useResumeDiscovery,
  useSay,
  useSetPhase,
} from '../api/queries/discovery.ts';
import { Composer } from '../components/chat/Composer.tsx';
import { DelegateGrants } from '../components/delegation/DelegateGrants.tsx';
import { DelegationSteps } from '../components/delegation/DelegationSteps.tsx';
import { CostMeter } from '../components/discovery/CostMeter.tsx';
import { DiscoveryConversation, type LiveTurn } from '../components/discovery/DiscoveryConversation.tsx';
import { DraftPanel } from '../components/discovery/DraftPanel.tsx';
import { PanelNotes } from '../components/discovery/PanelNotes.tsx';
import { PhaseStepper } from '../components/discovery/PhaseStepper.tsx';
import { PlaybookSteps } from '../components/discovery/PlaybookSteps.tsx';
import { ReadOnlyHint } from '../components/session/ReadOnlyHint.tsx';
import { ArchivedBanner, SessionAdmin } from '../components/session/SessionAdmin.tsx';
import { TimeWarning } from '../components/session/SessionCountdown.tsx';
import { TimeUpCard } from '../components/session/TimeUpCard.tsx';
import { Tabs } from '../components/ui/Tabs.tsx';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
} from '../components/ui.tsx';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { applyActivity, applyDelta } from '../lib/chatSegments.ts';
import { questionsToReview, waitingText } from '../lib/discovery.ts';
import { useCanManageOrg } from '../lib/orgRole.ts';
import { canManageOf } from '../lib/session.ts';
import { getSocket } from '../ws/socket.ts';

const errorText = (e: unknown): string | null =>
  !e ? null : e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);

type Tab = 'conversation' | 'panel' | 'draft';

/** One discovery session: the conversation with its question cards, the side panel and the draft. */
export function DiscoverySession() {
  const { id = '' } = useParams();
  const state = useDiscovery(id);
  const messages = useThreadMessages(id);
  const qc = useQueryClient();
  const mobile = useIsMobile();
  const isOrgManager = useCanManageOrg();
  const [tab, setTab] = useState<Tab>('conversation');
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [draft, setDraft] = useState('');

  const answer = useAnswerQuestion(id);
  const resolve = useResolveProposal(id);
  const say = useSay(id);
  const setPhase = useSetPhase(id);
  const pause = usePauseDiscovery(id);
  const resume = useResumeDiscovery(id);
  const carryOn = useContinueDiscovery(id);
  const timeAction = useDiscoveryTime(id);

  const s = state.data;
  const stateRef = useRef(s);
  stateRef.current = s;
  const speakerName = (turnId: string | null | undefined): string => {
    const t = turnId ? stateRef.current?.turns.find((x) => x.id === turnId) : undefined;
    return t?.speakerName ?? stateRef.current?.facilitatorName ?? 'Analyst';
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the stream follows the thread; names are read when a delta arrives
  useEffect(() => {
    setLive(null);
    return getSocket()?.listenChat(id, (ev) => {
      if (ev.type === 'delta')
        setLive((cur) => {
          const base =
            cur && cur.turnId === (ev.turnId ?? null)
              ? cur
              : {
                  turnId: ev.turnId ?? null,
                  name: speakerName(ev.turnId),
                  segments: [],
                  startedAt: Date.now(),
                };
          return { ...base, segments: applyDelta(base.segments, ev.text) };
        });
      else if (ev.type === 'activity')
        setLive((cur) => {
          const base =
            cur && cur.turnId === (ev.turnId ?? null)
              ? cur
              : {
                  turnId: ev.turnId ?? null,
                  name: speakerName(ev.turnId),
                  segments: [],
                  startedAt: Date.now(),
                };
          return { ...base, segments: applyActivity(base.segments, ev.activity) };
        });
      else if (ev.type === 'done' || ev.type === 'error' || ev.type === 'disconnected') {
        setLive(null);
        void qc.invalidateQueries({ queryKey: ['thread', id] });
        void qc.invalidateQueries({ queryKey: ['discovery', id] });
      }
    });
  }, [id, qc]);

  if (state.isPending) return <PageSkeleton label="Loading the session" panels={2} />;
  if (!s)
    return (
      <EmptyState
        icon={Compass}
        tone="neutral"
        title="Session not found"
        description="It may have been removed, or it belongs to someone else."
      />
    );

  const canManage = canManageOf(s);
  const archived = !!s.config.archived;
  const readOnly = archived || !canManage;
  const lastTurn = s.turns[s.turns.length - 1];
  const failed = !s.busy && lastTurn?.status === 'failed' && lastTurn.error !== 'cancelled';
  const toReview = questionsToReview(s.questions);
  const send = () => {
    const body = draft.trim();
    if (!body) return;
    say.mutate(body, { onSuccess: () => setDraft('') });
  };
  const conversation = (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="discovery-conversation">
      {!s.workstationOnline && (
        <Callout tone="warning" role="status">
          The workstation is offline. Turns wait for it and nothing is lost.
        </Callout>
      )}
      {archived && <ArchivedBanner>{canManage ? 'Reopen it to carry on.' : ''}</ArchivedBanner>}
      <TimeWarning time={s.time} steerer="facilitator" />
      {s.waitingFor === 'time' && (
        <TimeUpCard
          canManage={canManage}
          wrapLabel="Wrap up now (capture)"
          busy={timeAction.isPending}
          error={timeAction.error}
          onAction={(a) => timeAction.mutate(a)}
        />
      )}
      {s.config.paused && (
        <Callout
          tone="info"
          role="status"
          title="Paused"
          actions={
            canManage && !archived ? (
              <Button size="sm" onClick={() => resume.mutate()} loading={resume.isPending}>
                Resume
              </Button>
            ) : undefined
          }
        >
          The clock is stopped and nothing new starts. Your answers are kept; come back whenever you like.
        </Callout>
      )}
      {s.waitingFor === 'budget' && (
        <Callout tone="danger" role="alert" title="This session reached its budget">
          {`It has spent $${s.cost.costUsd.toFixed(2)}${s.cost.budgetUsd ? ` of $${s.cost.budgetUsd.toFixed(2)}` : ''}. No new turn starts until you raise the budget${canManage ? ' (use "Change budget" above).' : ': ask an Owner or Admin.'} What you wrote is kept.`}
        </Callout>
      )}
      {failed && (
        <Callout
          tone="warning"
          role="alert"
          title="The last turn did not finish"
          actions={
            canManage && !archived ? (
              <Button size="sm" onClick={() => carryOn.mutate()} loading={carryOn.isPending}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {lastTurn?.error}
        </Callout>
      )}
      {s.config.ceoPrep?.state === 'running' && (
        <Callout tone="info" role="status" title={`${s.ceoName ?? 'The CEO'} is preparing`}>
          {`The CEO and the analyst are working through the questions first (${s.config.ceoPrep.turns} of at most ${s.config.ceoPrep.cap} answers). You review every answer afterwards.`}
        </Callout>
      )}
      {s.config.ceoPrep?.state === 'review' && toReview.length > 0 && (
        <Callout
          tone="info"
          role="status"
          title={`Review ${toReview.length} CEO answer${toReview.length === 1 ? '' : 's'}`}
        >
          Confirm, edit or override each one below. Nothing counts as your answer until you do.
        </Callout>
      )}
      <DiscoveryConversation
        state={s}
        messages={messages.data?.messages ?? []}
        live={live}
        onAnswer={(questionId, body: AnswerQuestionRequest) => answer.mutate({ questionId, body })}
        onResolve={(proposalId, body: ResolveDiscoveryProposalRequest) =>
          resolve.mutate({ proposalId, body })
        }
        answerBusy={answer.isPending}
        answerError={errorText(answer.error)}
        resolveBusy={resolve.isPending}
        resolveError={errorText(resolve.error)}
        readOnly={readOnly}
      />
      {!canManage && !archived && <ReadOnlyHint />}
      <ErrorBox error={say.error} />
      {!archived && (
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={send}
          onStop={() => undefined}
          busy={false}
          placeholder={
            s.waitingFor === 'owner' ? 'Answer above, or write to the analyst' : 'Write to the analyst'
          }
          slash={{ context: 'session', ...(s.projectId ? { projectId: s.projectId } : {}) }}
        />
      )}
    </div>
  );

  const panel = <PanelNotes threadId={id} notes={s.notes} canManage={canManage} readOnly={archived} />;
  const drafts = <DraftPanel state={s} canManage={canManage && !archived} canHire={isOrgManager} />;

  return (
    <div className="mx-auto flex max-w-6xl flex-col" data-testid="discovery-session">
      <PageHeader
        title={s.title}
        documentTitle={`Discovery: ${s.title}`}
        back={{ to: '/discovery', label: 'All discovery sessions' }}
        eyebrow={
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge
              tone={
                s.waitingFor === 'owner' || s.waitingFor === 'review'
                  ? 'warning'
                  : s.waitingFor === 'budget'
                    ? 'danger'
                    : 'neutral'
              }
              data-testid="waiting-for"
            >
              {waitingText(s)}
            </Badge>
          </div>
        }
        actions={
          !canManage || archived ? undefined : s.config.paused ? (
            <Button onClick={() => resume.mutate()} loading={resume.isPending} data-testid="resume-session">
              <Play aria-hidden="true" className="size-4" />
              Resume
            </Button>
          ) : (
            <Button onClick={() => pause.mutate()} loading={pause.isPending} data-testid="pause-session">
              <Pause aria-hidden="true" className="size-4" />
              Pause
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-col gap-3">
        {s.config.playbookRun && <PlaybookSteps run={s.config.playbookRun} />}
        <PhaseStepper
          phase={s.config.phase}
          onSelect={readOnly ? undefined : (p) => setPhase.mutate(p)}
          disabled={setPhase.isPending}
        />
        <CostMeter state={s} canManage={canManage && !archived} />
        <DelegationSteps steps={s.delegations} />
        <DelegateGrants ownerKind="session" ownerId={id} />
        {canManage && <SessionAdmin threadId={id} archived={archived} backTo="/discovery" />}
        <ErrorBox error={setPhase.error ?? pause.error ?? resume.error ?? carryOn.error} />
      </div>
      {mobile ? (
        <div className="flex min-h-0 flex-col">
          <Tabs
            label="Session"
            prefix="session"
            value={tab}
            onChange={(t) => setTab(t as Tab)}
            tabs={[
              {
                id: 'conversation',
                label: 'Conversation',
                badge: s.waitingFor === 'owner' ? '●' : undefined,
              },
              { id: 'panel', label: `Panel (${s.notes.length})` },
              { id: 'draft', label: 'Draft' },
            ]}
          />
          {tab === 'conversation' && (
            <div className="h-[calc(100dvh-27rem)] min-h-[20rem] flex flex-col">{conversation}</div>
          )}
          {tab === 'panel' && panel}
          {tab === 'draft' && drafts}
        </div>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="flex h-[calc(100dvh-17rem)] min-h-[28rem] flex-col">{conversation}</div>
          <div className="flex flex-col gap-4">
            <Panel title="Panel" padding="default">
              {panel}
            </Panel>
            <Panel title="Draft" padding="default">
              {drafts}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
