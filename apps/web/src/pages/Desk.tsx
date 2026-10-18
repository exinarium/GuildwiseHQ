import { DESK_SUBKIND, type DeskItemDto, isPhaseDeskSubkind, WORKING_BRANCH_SUBKIND } from '@aom/shared';
import {
  Bell,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  CornerRightUp,
  type LucideIcon,
  MessageSquare,
  ShieldCheck,
  Star,
} from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useOverrideBudget } from '../api/queries/costs.ts';
import { useAnswerDeskItem, useDesk, useDismissDeskItem, useResolveDeskItem } from '../api/queries/desk.ts';
import { ApprovalDeskItem } from '../components/ApprovalDeskItem.tsx';
import { BaNote, FloorReport } from '../components/BaNote.tsx';
import { ChatDrawer } from '../components/ChatDrawer.tsx';
import {
  CeoAnswered,
  CeoRecommendation,
  CeoReportBlock,
  RememberCheckbox,
} from '../components/ceo/DeskCeo.tsx';
import { DigestRating } from '../components/DigestRating.tsx';
import { AskDevOpsButton } from '../components/devops/AskDevOps.tsx';
import { EscalationTrail } from '../components/EscalationTrail.tsx';
import { AgentAvatar, UserAvatar } from '../components/Face.tsx';
import { LedgerForm } from '../components/LedgerForm.tsx';
import { MappingForm } from '../components/MappingForm.tsx';
import { OutboundApproval } from '../components/OutboundApproval.tsx';
import { PhaseDeskItem } from '../components/PhaseDeskItem.tsx';
import { QaDeskItem } from '../components/QaDeskItem.tsx';
import { cx } from '../components/ui/cx.ts';
import {
  Avatar,
  Badge,
  BottomSheet,
  Button,
  ButtonLink,
  Callout,
  ConfirmDialog,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorBox,
  FilterChip,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  TextArea,
  useToast,
} from '../components/ui.tsx';
import { WorkingBranchQuestion } from '../components/WorkingBranchQuestion.tsx';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import {
  answerText,
  choiceFor,
  defaultOption,
  deskKindLabel,
  LEDGER_CHOICES,
  type LedgerChoiceKey,
  sortDeskItems,
} from '../lib/desk.ts';
import { useExpertMode } from '../lib/expert-mode.ts';
import { focusOf, integrationsLink } from '../lib/integrations.ts';
import { ageLabel, formatDateTime } from '../lib/time.ts';

type FilterKey = 'all' | 'blocking' | 'questions' | 'approvals' | 'notices' | 'ceo';
const FILTERS: Array<{ key: FilterKey; label: string; test: (i: DeskItemDto) => boolean }> = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'blocking', label: 'Blocking', test: (i) => i.blocking },
  { key: 'questions', label: 'Questions', test: (i) => i.kind === 'question' || i.kind === 'escalation' },
  { key: 'approvals', label: 'Approvals', test: (i) => i.kind === 'approval' },
  { key: 'notices', label: 'Notices', test: (i) => i.kind === 'alert' || i.kind === 'rating' },
  { key: 'ceo', label: 'Handled by CEO', test: (i) => !!i.ceo?.actionId },
];

const GROUPS: Array<{ id: string; label: string; test: (i: DeskItemDto) => boolean }> = [
  { id: 'first', label: 'Needs you first', test: (i) => i.urgent || i.pinned },
  { id: 'blocking', label: 'Blocking work', test: (i) => i.blocking },
  { id: 'decisions', label: 'Decisions', test: (i) => i.kind !== 'alert' && i.kind !== 'rating' },
  { id: 'notices', label: 'Heads-up', test: () => true },
];

const KIND_ICON: Record<string, LucideIcon> = {
  question: CircleHelp,
  approval: ShieldCheck,
  escalation: CornerRightUp,
  alert: Bell,
  rating: Star,
};

function DeskSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading the desk...</span>
      <div aria-hidden="true" className="space-y-3">
        <Skeleton className="h-8 w-56" />
        {['a', 'b', 'c'].map((k) => (
          <Skeleton key={k} className="h-40 rounded-card" />
        ))}
      </div>
    </div>
  );
}

export function Desk() {
  const open = useDesk({ status: 'open' });
  const closed = useDesk({ status: 'closed' });
  const [chatOpen, setChatOpen] = useState(false);
  const [showLedger, setShowLedger] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const nav = useNavigate();
  const mobile = useIsMobile();
  const [openId, setOpenId] = useState<string | null>(null);
  const filterKey = (FILTERS.find((f) => f.key === params.get('filter'))?.key ?? 'all') as FilterKey;
  const filter = FILTERS.find((f) => f.key === filterKey) ?? (FILTERS[0] as (typeof FILTERS)[number]);
  const [sort, setSort] = useState<'priority' | 'oldest' | 'newest'>('priority');

  const items = useMemo(() => sortDeskItems(open.data?.items ?? []), [open.data]);
  const shown = useMemo(() => {
    const f = items.filter(filter.test);
    if (sort === 'oldest') return [...f].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (sort === 'newest') return [...f].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return f;
  }, [items, filter, sort]);

  // `#desk-item-<id>` links (from a blocked card) scroll to the item once it is rendered, and flash it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run when the list or the hash changes
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    if (mobile && hash.startsWith('#desk-item-')) setOpenId(hash.slice('#desk-item-'.length));
    el.scrollIntoView({ block: 'center' });
    el.classList.add('animate-flash');
    const t = setTimeout(() => el.classList.remove('animate-flash'), 2000);
    return () => clearTimeout(t);
  }, [hash, items.length, mobile]);

  const openItem = openId ? (items.find((i) => i.id === openId) ?? null) : null;
  const closedShown = (closed.data?.items ?? []).filter(filterKey === 'ceo' ? filter.test : () => true);

  if (open.isPending)
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Decision desk" />
        <DeskSkeleton />
      </div>
    );
  const counts = open.data?.counts ?? { open: 0, blocking: 0, urgent: 0 };
  const count = (f: (typeof FILTERS)[number]) => items.filter(f.test).length;
  // group the (already ordered) items; the h2 order inside `desk-list` stays the API order
  const grouped =
    sort === 'priority'
      ? GROUPS.map((g, gi) => ({
          ...g,
          items: shown.filter((i) => GROUPS.findIndex((x) => x.test(i)) === gi),
        })).filter((g) => g.items.length > 0)
      : [{ id: 'all', label: sort === 'oldest' ? 'Oldest first' : 'Newest first', items: shown }];

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Decision desk"
        sub={
          <span data-testid="desk-counts">
            {counts.open} open · {counts.blocking} blocking
          </span>
        }
        actions={
          <>
            <Button onClick={() => setShowLedger(true)}>Add to ledger</Button>
            <Button data-testid="intake-button" onClick={() => nav('/intake')}>
              Intake
            </Button>
            <Button onClick={() => setChatOpen(true)}>
              <MessageSquare aria-hidden="true" className="size-4" />
              Chat
            </Button>
          </>
        }
      />
      <ErrorBox error={open.error} onRetry={() => open.refetch()} />
      <Dialog
        open={showLedger}
        onOpenChange={setShowLedger}
        title="Add a requirement or standing order"
        description="Agents read the ledger before they ask. Add something they should always know."
      >
        <LedgerForm onDone={() => setShowLedger(false)} />
      </Dialog>

      {items.length > 0 && (
        <div className="sticky top-14 z-10 -mx-4 mb-4 flex items-center gap-2 border-b border-line bg-canvas/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <div
            className="scroll-fade-x flex flex-1 gap-2 overflow-x-auto"
            role="group"
            aria-label="Filter items"
          >
            {FILTERS.filter(
              (f) =>
                f.key !== 'ceo' ||
                filterKey === 'ceo' ||
                count(f) > 0 ||
                (closed.data?.items ?? []).some(f.test),
            ).map((f) => (
              <FilterChip
                key={f.key}
                pressed={filterKey === f.key}
                count={count(f)}
                onClick={() =>
                  setParams(f.key === 'all' ? {} : { filter: f.key }, {
                    replace: true,
                    preventScrollReset: true,
                  })
                }
              >
                {f.label}
              </FilterChip>
            ))}
          </div>
          <label className="hidden items-center gap-2 text-sm text-muted sm:flex">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              className="h-8 rounded-control border border-control bg-surface px-2 text-sm text-fg"
            >
              <option value="priority">Priority</option>
              <option value="oldest">Oldest</option>
              <option value="newest">Newest</option>
            </select>
          </label>
        </div>
      )}

      {items.length === 0 && (
        <EmptyState
          data-testid="desk-empty"
          icon={CheckCheck}
          tone="success"
          title="All clear. Nothing is waiting on you."
          description="Questions, approvals and heads-ups from your agents show up here."
          action={<ButtonLink to="/">Go to the board</ButtonLink>}
        />
      )}
      {items.length > 0 && shown.length === 0 && (
        <EmptyState
          icon={CheckCheck}
          tone="neutral"
          title="Nothing matches this filter"
          action={<Button onClick={() => setParams({}, { replace: true })}>Show all items</Button>}
        />
      )}
      <div data-testid="desk-list" className="flex flex-col gap-6">
        {grouped.map((g) => (
          <section key={g.id} aria-label={g.label}>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted">
              {g.label}
              <span className="tnum rounded-full bg-sunken px-2 text-xs font-medium">{g.items.length}</span>
            </h3>
            <ol className="flex flex-col gap-3" aria-label={`${g.label} items`}>
              {g.items.map((item) => (
                <li key={item.id}>
                  {mobile ? (
                    <DeskCard item={item} onOpen={() => setOpenId(item.id)} />
                  ) : (
                    <DeskItem item={item} />
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      {closedShown.length > 0 && (
        <details
          className="mt-8"
          data-testid="desk-closed"
          open={showClosed}
          onToggle={(e) => setShowClosed((e.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-fg">
            Answered and closed ({closedShown.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-2">
            {closedShown.map((i) => (
              <li key={i.id} data-testid={`desk-closed-${i.id}`}>
                <Panel padding="compact">
                  <p className="text-base font-medium text-fg">{i.title}</p>
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-subtle">
                    <span>{i.status}</span>
                    {i.answeredByName && (
                      <span className="inline-flex items-center gap-1.5" data-testid="answered-by">
                        by
                        <UserAvatar
                          user={{
                            id: i.answeredByUserId,
                            displayName: i.answeredByName,
                            avatar: i.answeredByAvatar,
                          }}
                          size={18}
                        />
                        {i.answeredByName}
                      </span>
                    )}
                    {i.answeredByAgentName && (
                      <span className="inline-flex items-center gap-1.5" data-testid="answered-by">
                        by
                        <AgentAvatar agentId={i.answeredByAgentId} name={i.answeredByAgentName} size={18} />
                        {i.answeredByAgentName} (without reaching the desk)
                      </span>
                    )}
                    <span>· {formatDateTime(i.answeredAt)}</span>
                  </p>
                  {i.answer && <p className="mt-1 text-sm whitespace-pre-wrap text-muted">{i.answer}</p>}
                  <CeoAnswered item={i} />
                  <EscalationTrail item={i} />
                </Panel>
              </li>
            ))}
          </ul>
        </details>
      )}
      <ChatDrawer open={chatOpen} onOpenChange={setChatOpen} />
      {mobile && (
        <BottomSheet
          open={!!openItem}
          onOpenChange={(o) => !o && setOpenId(null)}
          size="full"
          title={openItem ? deskKindLabel(openItem) : 'Item'}
          testId="desk-sheet"
        >
          {openItem && <DeskItem item={openItem} bare />}
        </BottomSheet>
      )}
    </div>
  );
}

/** Phone list row: priority, title, who and what it is about, and how long it waits. Tap opens the item full screen. */
export function DeskCard({ item, now, onOpen }: { item: DeskItemDto; now?: number; onOpen: () => void }) {
  const Icon = KIND_ICON[item.kind] ?? CircleHelp;
  const project = item.card?.ref ? item.card.ref.slice(0, Math.max(0, item.card.ref.lastIndexOf('-'))) : null;
  return (
    <button
      type="button"
      id={`desk-item-${item.id}`}
      data-testid={`desk-card-${item.id}`}
      data-kind={item.kind}
      data-blocking={item.blocking}
      aria-label={item.title}
      onClick={onOpen}
      className={cx(
        'flex min-h-14 w-full items-center gap-3 rounded-card border border-line border-l-[3px] bg-surface p-3 text-left shadow-sm active:bg-sunken',
        item.urgent ? 'border-l-danger-fill' : item.blocking ? 'border-l-warning-fill' : 'border-l-line',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          {item.urgent && <Badge tone="red">Urgent</Badge>}
          {item.blocking && <Badge tone="amber">Blocking</Badge>}
          <Badge tone="violet" icon={<Icon aria-hidden="true" />}>
            {deskKindLabel(item)}
          </Badge>
        </span>
        <span className="mt-1.5 line-clamp-2 block text-base font-semibold [overflow-wrap:anywhere] text-fg">
          {item.title}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-subtle">
          {project && <span className="font-mono">{project}</span>}
          {item.card && <span className="font-mono">{item.card.ref}</span>}
          <span className="tnum">{ageLabel(item.createdAt, now)} ago</span>
        </span>
      </span>
      <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-subtle" />
    </button>
  );
}

/** Questions (and escalations) are answered with the option list and note; the CEO's recommendation goes in there. */
function usesAnswerForm(item: DeskItemDto): boolean {
  return (
    item.status === 'open' &&
    item.canAnswer &&
    item.subkind !== 'manual_qa' &&
    !isPhaseDeskSubkind(item.subkind) &&
    item.subkind !== 'unmapped_ticket' &&
    item.subkind !== WORKING_BRANCH_SUBKIND &&
    (item.kind === 'question' || (item.kind === 'escalation' && item.subkind !== 'vault_conflict'))
  );
}

/** One desk item: who asks, what they were doing, the question, options and the answer form. */
export function DeskItem({ item, now, bare = false }: { item: DeskItemDto; now?: number; bare?: boolean }) {
  const Icon = KIND_ICON[item.kind] ?? CircleHelp;
  return (
    <article
      {...(bare ? {} : { id: `desk-item-${item.id}` })}
      data-testid={`desk-item-${item.id}`}
      data-kind={item.kind}
      data-blocking={item.blocking}
      data-pinned={item.pinned}
      aria-label={item.title}
      className={cx(
        'rounded-card border border-line border-l-[3px] bg-surface p-4 shadow-sm sm:p-5',
        bare &&
          'max-md:-mx-4 max-md:-my-3 max-md:rounded-none max-md:border-0 max-md:border-l-[3px] max-md:shadow-none',
        item.urgent ? 'border-l-danger-fill' : item.blocking ? 'border-l-warning-fill' : 'border-l-line',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {item.urgent && (
          <Badge tone="red" title="Pinned: needs you first">
            <span data-testid="urgent-badge">Urgent</span>
          </Badge>
        )}
        <Badge tone="violet" icon={<Icon aria-hidden="true" />}>
          <span data-testid="desk-kind">{deskKindLabel(item)}</span>
        </Badge>
        {item.blocking && <Badge tone="amber">Blocking</Badge>}
        {(item.repeatCount ?? 1) > 1 && (
          <Badge tone="neutral" title="The same thing was raised again while this item was open">
            <span data-testid="repeat-count">x{item.repeatCount}</span>
          </Badge>
        )}
        <span className="text-xs text-subtle" data-testid="affected-count">
          Affects {item.affectedCount} {item.affectedCount === 1 ? 'card' : 'cards'}
        </span>
        <span className="tnum ml-auto text-xs text-subtle" title={formatDateTime(item.createdAt)}>
          asked {ageLabel(item.createdAt, now)} ago
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {item.askedBy.agentName && (
          <span className="inline-flex items-center gap-1.5 font-medium text-fg" data-testid="asked-by">
            <AgentAvatar agentId={item.askedBy.agentId} name={item.askedBy.agentName} size={20} />
            {item.askedBy.agentName}
            {item.askedBy.role && <span className="font-normal text-subtle">({item.askedBy.role})</span>}
          </span>
        )}
        {item.card && (
          <Link
            to={`/cards/${item.card.ref}`}
            className="min-w-0 truncate text-brand-text hover:underline"
            data-testid="item-card"
          >
            <span className="font-mono text-xs">{item.card.ref}</span> {item.card.title}
          </Link>
        )}
      </div>
      {item.doing && (
        <p className="mt-1 text-xs text-subtle" data-testid="item-doing">
          Was doing: {item.doing}
        </p>
      )}
      <h2 className="mt-3 text-lg font-semibold whitespace-pre-wrap text-fg">{item.title}</h2>
      {item.body && item.kind !== 'rating' && (
        <p className="mt-1.5 text-base whitespace-pre-wrap text-muted">{item.body}</p>
      )}
      {item.subkind === 'ceo_report' && <CeoReportBlock item={item} />}
      <CeoAnswered item={item} />
      {!usesAnswerForm(item) && <CeoRecommendation item={item} />}
      {item.floor && (
        <details className="mt-3" data-testid="floor-facts">
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-fg">
            The facts behind this report
          </summary>
          <FloorReport digest={item.floor} />
        </details>
      )}
      <BaNote item={item} />
      {item.hint && (
        <Callout tone="warning" className="mt-3" role="note" data-testid="desk-hint">
          {item.hint}
        </Callout>
      )}
      {item.subkind === 'definition' && (
        <p className="mt-2 text-sm text-muted">
          <Link to="/org?tab=workflows" className="text-brand-text underline" data-testid="open-org">
            Open the Organization page
          </Link>{' '}
          to see the stage table, graph and validation. Nothing is available until you approve.
        </p>
      )}
      {(item.subkind === DESK_SUBKIND.claudeAuthExpired || item.subkind === DESK_SUBKIND.mcpNeedsSignIn) && (
        <SignInFromWeb item={item} />
      )}
      {item.kind === 'rating' && item.interest && (
        <p className="mt-1 text-sm text-muted">
          From the interest{' '}
          <Link
            to={`/interests/${item.interest.id}?tab=digest`}
            className="text-brand-text underline"
            data-testid="desk-interest-link"
          >
            {item.interest.name}
          </Link>
          .
        </p>
      )}
      {item.kind === 'rating' && item.digestItems && (
        <DigestRating items={item.digestItems} canRate={item.status === 'open' && item.canAnswer} />
      )}

      {item.dedupEntries.length > 0 && (
        <Callout
          tone="warning"
          className="mt-3"
          data-testid="dedup-entries"
          title="The ledger already has similar entries:"
        >
          <ul className="mt-1 list-disc pl-4">
            {item.dedupEntries.map((e) => (
              <li key={e.id}>
                <span className="font-medium">{e.title}</span> ({e.scope.replace('_', ' ')}):{' '}
                {e.body.replace(/\s+/g, ' ').slice(0, 200)}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <EscalationTrail item={item} />

      {item.status !== 'open' ? (
        <p className="mt-3 text-sm text-subtle">
          {item.status}
          {item.answer ? `: ${item.answer}` : ''}
        </p>
      ) : !item.canAnswer ? (
        <p className="mt-3 text-sm text-subtle" data-testid="read-only">
          Read only:{' '}
          {item.subkind === 'manual_qa'
            ? 'only the person asked to test this card, or a project owner or manager, can answer this.'
            : item.subkind === 'approval_step'
              ? 'only the person asked to approve this card, the project owner or an organization Owner or Admin can answer this.'
              : item.card
                ? 'only the card owner can answer this.'
                : 'only the project owner can answer.'}
        </p>
      ) : item.subkind === 'manual_qa' ? (
        <QaDeskItem item={item} />
      ) : item.subkind === 'approval_step' ? (
        <ApprovalDeskItem item={item} />
      ) : isPhaseDeskSubkind(item.subkind) ? (
        <PhaseDeskItem item={item} />
      ) : item.subkind === 'unmapped_ticket' ? (
        <MappingForm item={item} />
      ) : item.kind === 'approval' && item.subkind === 'outbound' ? (
        <OutboundApproval item={item} />
      ) : item.subkind === WORKING_BRANCH_SUBKIND ? (
        <WorkingBranchQuestion item={item} />
      ) : item.kind === 'question' || (item.kind === 'escalation' && item.subkind !== 'vault_conflict') ? (
        <AnswerForm item={item} />
      ) : (
        <ResolveButtons item={item} />
      )}
      {item.kind !== 'question' && item.kind !== 'rating' && (
        <div className="mt-3">
          <AskDevOpsButton
            variant="quiet"
            label="Ask DevOps about this"
            request={{
              origin: 'desk',
              deskItemId: item.id,
              deskLabel: item.title,
              errorText: item.body.slice(0, 1500),
              ...(item.projectId ? { projectId: item.projectId } : {}),
            }}
          />
        </div>
      )}
    </article>
  );
}

/** Dismiss asks first: it closes the item without an answer and tells the asker. */
/**
 * "Sign in from the web" on the two workstation sign-in notices. The server may carry `data.workstationId` and
 * `data.key` (`mcp_signin:<workstation>:<server>`) on the item; without them the link goes to /integrations, which picks
 * the workstation.
 */
function SignInFromWeb({ item }: { item: DeskItemDto }) {
  const data = (item as { data?: { workstationId?: string; key?: string } }).data;
  const mcp = item.subkind === DESK_SUBKIND.mcpNeedsSignIn;
  const server = mcp ? data?.key?.split(':').slice(2).join(':') : undefined;
  const focus = mcp ? (server ? focusOf('mcp', server) : 'mcp') : 'claude-code';
  return (
    <p className="mt-2 text-sm">
      <Link
        to={integrationsLink(data?.workstationId, focus, { connect: !mcp || !!server })}
        className="text-brand-text underline"
        data-testid="desk-sign-in-web"
      >
        Sign in from the web
      </Link>
    </p>
  );
}

function DismissButton({ item }: { item: DeskItemDto }) {
  const dismiss = useDismissDeskItem();
  const toast = useToast();
  const [ask, setAsk] = useState(false);
  return (
    <>
      <Button variant="ghost" onClick={() => setAsk(true)}>
        Dismiss
      </Button>
      <ConfirmDialog
        open={ask}
        onOpenChange={setAsk}
        title="Dismiss without answering?"
        description="The item closes and the asker is told you declined. You cannot undo this."
        confirmLabel="Dismiss"
        cancelLabel="Keep"
        pending={dismiss.isPending}
        onConfirm={() =>
          dismiss.mutate(item.id, {
            onSuccess: () => {
              setAsk(false);
              toast.success('Dismissed');
            },
            onError: () => setAsk(false),
          })
        }
      />
    </>
  );
}

function AnswerForm({ item }: { item: DeskItemDto }) {
  const answer = useAnswerDeskItem();
  const toast = useToast();
  const rec = item.ceo?.recommendation ?? null;
  const recOption = rec?.option && item.options.some((o) => o.id === rec.option) ? rec.option : null;
  const [optionId, setOptionId] = useState<string | null>(recOption ?? defaultOption(item));
  const [remember, setRemember] = useState(false);
  const [typed, setTyped] = useState('');
  const [choice, setChoice] = useState<LedgerChoiceKey>('decision');
  const [err, setErr] = useState('');
  const text = answerText(typed, optionId, item.options);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text) return setErr('Choose an option or write an answer');
    setErr('');
    answer.mutate(
      {
        id: item.id,
        body: {
          answer: text,
          ...(optionId ? { optionId } : {}),
          ledger: choiceFor(choice),
          ...(remember ? { remember: true } : {}),
        },
      },
      { onSuccess: () => toast.success('Answer sent. The agent carries on.') },
    );
  };
  // "Accept recommendation": answer with exactly what the CEO recommends.
  const acceptText = recOption ? answerText('', recOption, item.options) : (rec?.text ?? '');
  const accept = () =>
    answer.mutate(
      {
        id: item.id,
        body: {
          answer: acceptText,
          ...(recOption ? { optionId: recOption } : {}),
          ledger: choiceFor('decision'),
        },
      },
      { onSuccess: () => toast.success('Answer sent. The agent carries on.') },
    );

  return (
    <form onSubmit={submit} aria-label="Answer" className="mt-4 flex flex-col gap-4" noValidate>
      <CeoRecommendation
        item={item}
        onAccept={acceptText ? accept : undefined}
        accepting={answer.isPending}
      />
      {item.options.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium text-fg">Options</legend>
          {item.options.map((o) => (
            <label
              key={o.id}
              className={cx(
                'flex cursor-pointer items-start gap-3 rounded-card border p-3 text-base transition-colors',
                optionId === o.id ? 'border-brand bg-brand-soft' : 'border-control hover:bg-sunken',
              )}
            >
              <input
                type="radio"
                name={`option-${item.id}`}
                value={o.id}
                checked={optionId === o.id}
                onChange={() => setOptionId(o.id)}
                className="mt-0.5 size-4"
              />
              <span className="flex-1 text-fg">
                {o.label}
                {o.description && <span className="block text-sm text-muted">{o.description}</span>}
              </span>
              {item.recommendation === o.id && (
                <Badge tone="green" title="The asker's recommended default">
                  Recommended
                </Badge>
              )}
            </label>
          ))}
        </fieldset>
      )}
      <TextArea
        label={item.options.length ? 'Note (optional, replaces the option text)' : 'Answer'}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        error={err}
      />
      <RememberCheckbox checked={remember} onChange={setRemember} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="sm:w-72">
          <Select
            label="Add to ledger as"
            value={choice}
            onChange={(e) => setChoice(e.target.value as LedgerChoiceKey)}
          >
            {LEDGER_CHOICES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="sticky-actions flex flex-col-reverse gap-2 sm:flex-row [&>button]:max-sm:w-full">
          <DismissButton item={item} />
          <Button type="submit" variant="primary" loading={answer.isPending}>
            Answer
          </Button>
        </div>
      </div>
      <ErrorBox error={answer.error} />
    </form>
  );
}

/** The pause notice of a project over its monthly budget: raise the budget, or override it for this month. */
function BudgetActions({ item }: { item: DeskItemDto }) {
  const nav = useNavigate();
  const override = useOverrideBudget('projects', item.budgetProject?.projectId ?? '');
  const toast = useToast();
  return (
    <>
      <Button
        variant="primary"
        data-testid="desk-budget-raise"
        onClick={() =>
          nav(
            item.budgetProject?.interestId
              ? `/interests/${item.budgetProject.interestId}?tab=settings#budget`
              : `/projects/${item.budgetProject?.projectId}/settings#budget`,
          )
        }
      >
        Raise budget
      </Button>
      <Button
        loading={override.isPending}
        data-testid="desk-budget-override"
        onClick={() =>
          override.mutate(undefined, { onSuccess: () => toast.success('Overridden for this month') })
        }
      >
        Override for this month
      </Button>
      <ErrorBox error={override.error} />
    </>
  );
}

function ResolveButtons({ item }: { item: DeskItemDto }) {
  const expert = useExpertMode();
  const nav = useNavigate();
  const resolve = useResolveDeskItem();
  const toast = useToast();
  // A curator's taste-rule proposal can be reworded before it is approved (the edited text is what taste.md gets).
  const [rule, setRule] = useState(item.body);
  const editable =
    item.kind === 'approval' && (item.subkind === 'taste_rule' || item.subkind === 'standing_order');
  const edited = editable && rule.trim() && rule.trim() !== item.body.trim() ? rule.trim() : undefined;
  const done = (msg: string) => ({ onSuccess: () => toast.success(msg) });
  const mobile = useIsMobile();
  const [confirmApprove, setConfirmApprove] = useState(false);
  const approveLabel =
    item.subkind === 'ceo_recommendation'
      ? 'Do it'
      : item.subkind === 'large_merge'
        ? 'Approve merge'
        : item.subkind === 'repo_create'
          ? 'Create repository'
          : 'Approve';
  const approve = () =>
    resolve.mutate(
      { id: item.id, body: { resolution: 'approved', ...(edited ? { editedBody: edited } : {}) } },
      {
        onSuccess: () => {
          setConfirmApprove(false);
          toast.success(item.subkind === 'ceo_recommendation' ? 'Done' : 'Approved');
        },
        onError: () => setConfirmApprove(false),
      },
    );
  return (
    <div className="mt-4 flex flex-col gap-3">
      {/* On a phone an approval is two taps: the button, then a confirmation sheet (no accidental thumb approvals). */}
      <ConfirmDialog
        open={confirmApprove}
        onOpenChange={setConfirmApprove}
        title={`${approveLabel}?`}
        description={item.title}
        confirmLabel={approveLabel}
        tone="primary"
        pending={resolve.isPending}
        onConfirm={approve}
      />
      {editable && (
        <TextArea
          label={item.subkind === 'standing_order' ? 'Standing order (editable)' : 'Rule (editable)'}
          value={rule}
          onChange={(e) => setRule(e.target.value)}
        />
      )}
      <ErrorBox error={resolve.error} />
      <div className="sticky-actions flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap [&>button]:max-sm:w-full">
        <DismissButton item={item} />
        {item.kind === 'approval' ? (
          <>
            <Button
              onClick={() =>
                resolve.mutate(
                  { id: item.id, body: { resolution: 'rejected' } },
                  done(item.subkind === 'ceo_recommendation' ? 'Not now' : 'Rejected'),
                )
              }
            >
              {item.subkind === 'ceo_recommendation' ? 'Not now' : 'Reject'}
            </Button>
            <Button
              variant="primary"
              loading={resolve.isPending}
              data-testid="desk-approve"
              onClick={() => (mobile ? setConfirmApprove(true) : approve())}
            >
              {approveLabel}
            </Button>
          </>
        ) : item.subkind === 'budget_paused' && item.budgetProject ? (
          <BudgetActions item={item} />
        ) : item.subkind === 'repo_create_failed' ? (
          // Also for alerts the server stored without options: Retry queues the same request again.
          <Button
            variant="primary"
            onClick={() =>
              resolve.mutate({ id: item.id, body: { resolution: 'approved' } }, done('Retrying'))
            }
          >
            Retry
          </Button>
        ) : (
          <>
            {item.subkind === 'tester_bottleneck' && (
              <Button
                variant="primary"
                data-testid="hire-tester"
                onClick={() =>
                  nav(`/agents?hire=tester${item.projectId ? `&projectId=${item.projectId}` : ''}`)
                }
              >
                Hire tester
              </Button>
            )}
            <Button
              variant={item.subkind === 'tester_bottleneck' ? 'secondary' : 'primary'}
              onClick={() =>
                resolve.mutate({ id: item.id, body: { resolution: 'acknowledged' } }, done('Acknowledged'))
              }
            >
              {item.subkind === 'vault_conflict' ? 'Conflict resolved, resume sync' : 'Acknowledge'}
            </Button>
          </>
        )}
      </div>
      {item.subkind === 'large_merge' && (
        <p className="text-xs text-subtle">
          {expert
            ? 'Approving merges into the working branch. It cannot be undone from here.'
            : 'Approving puts this change live on main. It cannot be undone from here.'}
        </p>
      )}
    </div>
  );
}
