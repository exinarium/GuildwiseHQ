import { BOARD_FORMAT_LABEL } from '@aom/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Pause, Play, Square, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError } from '../api/client.ts';
import {
  useBoard,
  useBoardSay,
  useContinueBoard,
  useEndBoard,
  usePauseBoard,
  useResolveDecision,
  useResumeBoard,
} from '../api/queries/boardroom.ts';
import { useThreadMessages } from '../api/queries/chats.ts';
import { BoardComposer } from '../components/boardroom/BoardComposer.tsx';
import { BoardConversation, type LiveBoardTurn } from '../components/boardroom/BoardConversation.tsx';
import { BoardMeters } from '../components/boardroom/BoardMeters.tsx';
import { MinutesPanel } from '../components/boardroom/MinutesPanel.tsx';
import { Whiteboard } from '../components/boardroom/Whiteboard.tsx';
import { Tabs } from '../components/ui/Tabs.tsx';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
} from '../components/ui.tsx';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { boardWaitingText } from '../lib/boardroom.ts';
import { applyActivity, applyDelta } from '../lib/chatSegments.ts';
import { useCanManageOrg } from '../lib/orgRole.ts';
import { getSocket } from '../ws/socket.ts';

const errorText = (e: unknown): string | null =>
  !e ? null : e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);

type Tab = 'conversation' | 'whiteboard' | 'minutes';

/** One boardroom: the group conversation, the whiteboard, the cost meter and the minutes. */
export function BoardroomSession() {
  const { id = '' } = useParams();
  const state = useBoard(id);
  const messages = useThreadMessages(id);
  const qc = useQueryClient();
  const mobile = useIsMobile();
  const canManage = useCanManageOrg();
  const [tab, setTab] = useState<Tab>('conversation');
  const [live, setLive] = useState<LiveBoardTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);

  const say = useBoardSay(id);
  const pause = usePauseBoard(id);
  const resume = useResumeBoard(id);
  const carryOn = useContinueBoard(id);
  const end = useEndBoard(id);
  const decide = useResolveDecision(id);

  const s = state.data;
  const stateRef = useRef(s);
  stateRef.current = s;
  const turnInfo = (turnId: string | null | undefined, participantId?: string | null) => {
    const t = turnId ? stateRef.current?.turns.find((x) => x.id === turnId) : undefined;
    const pid = participantId ?? t?.participantId ?? null;
    const seat = stateRef.current?.cast.find((c) => c.participantId === pid);
    return { name: t?.speakerName ?? seat?.displayName ?? 'Speaker', participantId: pid };
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the stream follows the thread; names are read when a delta arrives
  useEffect(() => {
    setLive([]);
    const upsert = (turnId: string | null, f: (l: LiveBoardTurn) => LiveBoardTurn) =>
      setLive((cur) => {
        const i = cur.findIndex((l) => l.turnId === turnId);
        const base: LiveBoardTurn =
          i >= 0
            ? (cur[i] as LiveBoardTurn)
            : { turnId, ...turnInfo(turnId), segments: [], startedAt: Date.now() };
        const next = f(base);
        return i >= 0 ? cur.map((l, k) => (k === i ? next : l)) : [...cur, next];
      });
    return getSocket()?.listenChat(id, (ev) => {
      if (ev.type === 'delta')
        upsert(ev.turnId ?? null, (b) => ({ ...b, segments: applyDelta(b.segments, ev.text) }));
      else if (ev.type === 'activity')
        upsert(ev.turnId ?? null, (b) => ({ ...b, segments: applyActivity(b.segments, ev.activity) }));
      else if (ev.type === 'done') {
        setLive((cur) => cur.filter((l) => l.turnId !== (ev.turnId ?? null)));
        void qc.invalidateQueries({ queryKey: ['thread', id] });
        void qc.invalidateQueries({ queryKey: ['discovery', id] });
      } else if (ev.type === 'error' || ev.type === 'disconnected') {
        setLive([]);
        void qc.invalidateQueries({ queryKey: ['thread', id] });
        void qc.invalidateQueries({ queryKey: ['discovery', id] });
      }
    });
  }, [id, qc]);

  if (state.isPending) return <PageSkeleton label="Loading the boardroom" panels={2} />;
  if (!s)
    return (
      <EmptyState
        icon={Users}
        tone="neutral"
        title="Boardroom not found"
        description="It may have been removed, or it belongs to someone else."
      />
    );

  const over = s.config.stage === 'ended';
  const lastTurn = s.turns[s.turns.length - 1];
  const failed = !s.busy && lastTurn?.status === 'failed' && lastTurn.error !== 'cancelled' && !over;
  const send = () => {
    const body = draft.trim();
    if (!body) return;
    say.mutate(body, { onSuccess: () => setDraft('') });
  };

  const conversation = (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="board-conversation">
      {!s.workstationOnline && (
        <Callout tone="warning" role="status">
          The workstation is offline. Turns wait for it and nothing is lost.
        </Callout>
      )}
      {s.config.paused && (
        <Callout
          tone="info"
          role="status"
          title="Paused"
          actions={
            <Button size="sm" onClick={() => resume.mutate()} loading={resume.isPending}>
              Resume
            </Button>
          }
        >
          Nothing new starts. What has been said is kept; come back whenever you like.
        </Callout>
      )}
      {s.waitingFor === 'budget' && (
        <Callout tone="danger" role="alert" title="This boardroom reached its budget">
          {`It has spent $${s.cost.costUsd.toFixed(2)}${s.cost.budgetUsd ? ` of $${s.cost.budgetUsd.toFixed(2)}` : ''}. No new turn starts until you raise the budget${canManage ? ' (use "Change budget" above).' : ': ask an Owner or Admin.'} You can still end the session and get the minutes.`}
        </Callout>
      )}
      {failed && (
        <Callout
          tone="warning"
          role="alert"
          title="The last turn did not finish"
          actions={
            <Button size="sm" onClick={() => carryOn.mutate()} loading={carryOn.isPending}>
              Try again
            </Button>
          }
        >
          {lastTurn?.error}
        </Callout>
      )}
      <BoardConversation
        state={s}
        messages={messages.data?.messages ?? []}
        live={live}
        onResolve={(v) => decide.mutate(v)}
        resolveBusy={decide.isPending}
        resolveError={errorText(decide.error)}
      />
      <ErrorBox error={say.error} />
      {!over && (
        <BoardComposer
          value={draft}
          onChange={setDraft}
          onSend={send}
          cast={s.cast}
          placeholder={
            s.waitingFor === 'decision'
              ? 'Decide above, or write to the room (use @ to call on a seat)'
              : 'Interject, or @mention a seat to hear from it next'
          }
        />
      )}
      {over && (
        <Callout tone="success" role="status" title="This session is over">
          The minutes are in the Minutes tab. Pull them into a PRD to carry on.
        </Callout>
      )}
    </div>
  );

  const board = <Whiteboard state={s} />;
  const minutes = <MinutesPanel state={s} canManage={canManage} />;

  return (
    <div className="mx-auto flex max-w-6xl flex-col" data-testid="boardroom-session">
      <PageHeader
        title={s.title}
        documentTitle={`Boardroom: ${s.title}`}
        back={{ to: '/boardroom', label: 'All boardrooms' }}
        eyebrow={
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge
              tone={
                s.waitingFor === 'owner' || s.waitingFor === 'decision'
                  ? 'warning'
                  : s.waitingFor === 'budget'
                    ? 'danger'
                    : 'neutral'
              }
              data-testid="waiting-for"
            >
              {boardWaitingText(s)}
            </Badge>
            <Badge tone="brand">{BOARD_FORMAT_LABEL[s.config.format]}</Badge>
            {s.chairStatus && (
              <span className="text-xs text-muted" data-testid="chair-status">
                {s.chairStatus}
              </span>
            )}
          </div>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {!over &&
              (s.config.paused ? (
                <Button
                  onClick={() => resume.mutate()}
                  loading={resume.isPending}
                  data-testid="resume-session"
                >
                  <Play aria-hidden="true" className="size-4" />
                  Resume
                </Button>
              ) : (
                <Button onClick={() => pause.mutate()} loading={pause.isPending} data-testid="pause-session">
                  <Pause aria-hidden="true" className="size-4" />
                  Pause
                </Button>
              ))}
            {!over && s.config.stage !== 'minutes' && (
              <Button variant="danger" onClick={() => setConfirmEnd(true)} data-testid="end-session">
                <Square aria-hidden="true" className="size-4" />
                End session
              </Button>
            )}
          </div>
        }
      />
      <div className="mb-4 flex flex-col gap-3">
        <BoardMeters state={s} canManage={canManage} />
        <ul className="flex flex-wrap gap-1.5" aria-label="Cast" data-testid="cast">
          {s.cast.map((c) => (
            <li key={c.participantId} className="rounded-full bg-sunken px-2.5 py-1 text-xs text-fg">
              {c.displayName}
              <span className="ml-1 text-subtle">@{c.slug}</span>
            </li>
          ))}
        </ul>
        <ErrorBox error={pause.error ?? resume.error ?? carryOn.error ?? end.error} />
      </div>
      {mobile ? (
        <div className="flex min-h-0 flex-col">
          <Tabs
            label="Boardroom"
            prefix="board"
            value={tab}
            onChange={(t) => setTab(t as Tab)}
            tabs={[
              {
                id: 'conversation',
                label: 'Conversation',
                badge: s.waitingFor === 'decision' || s.waitingFor === 'owner' ? '●' : undefined,
              },
              { id: 'whiteboard', label: `Whiteboard (${s.notes.length})` },
              { id: 'minutes', label: 'Minutes' },
            ]}
          />
          {tab === 'conversation' && (
            <div className="flex h-[calc(100dvh-30rem)] min-h-[20rem] flex-col">{conversation}</div>
          )}
          {tab === 'whiteboard' && board}
          {tab === 'minutes' && minutes}
        </div>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_26rem]">
          <div className="flex h-[calc(100dvh-19rem)] min-h-[28rem] flex-col">{conversation}</div>
          <div className="flex flex-col gap-4">
            <Panel title="Whiteboard" padding="default">
              {board}
            </Panel>
            <Panel title="Minutes" padding="default">
              {minutes}
            </Panel>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title="End the session?"
        description="Turns that have not started are dropped, and the Chair writes the minutes. You can still pull them into a PRD."
        confirmLabel="End session"
        tone="danger"
        pending={end.isPending}
        onConfirm={() => end.mutate(undefined, { onSuccess: () => setConfirmEnd(false) })}
      />
    </div>
  );
}
