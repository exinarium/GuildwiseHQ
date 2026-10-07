import { type DeskItemDto, isPhaseDeskSubkind, WORKING_BRANCH_SUBKIND } from '@aom/shared';
import {
  Bell,
  CheckCheck,
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
import { BaNote, FloorReport } from '../components/BaNote.tsx';
import { ChatDrawer } from '../components/ChatDrawer.tsx';
import { DigestRating } from '../components/DigestRating.tsx';
import { EscalationTrail } from '../components/EscalationTrail.tsx';
import { AgentAvatar, UserAvatar } from '../components/Face.tsx';
import { LedgerForm } from '../components/LedgerForm.tsx';
import { MappingForm } from '../components/MappingForm.tsx';
import { OutboundApproval } from '../components/OutboundApproval.tsx';
import { PhaseDeskItem } from '../components/PhaseDeskItem.tsx';
import { cx } from '../components/ui/cx.ts';
import {
  Avatar,
  Badge,
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
import {
  answerText,
  choiceFor,
  defaultOption,
  deskKindLabel,
  LEDGER_CHOICES,
  type LedgerChoiceKey,
  sortDeskItems,
} from '../lib/desk.ts';
import { ageLabel, formatDateTime } from '../lib/time.ts';

type FilterKey = 'all' | 'blocking' | 'questions' | 'approvals' | 'notices';
const FILTERS: Array<{ key: FilterKey; label: string; test: (i: DeskItemDto) => boolean }> = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'blocking', label: 'Blocking', test: (i) => i.blocking },
  { key: 'questions', label: 'Questions', test: (i) => i.kind === 'question' || i.kind === 'escalation' },
  { key: 'approvals', label: 'Approvals', test: (i) => i.kind === 'approval' },
  { key: 'notices', label: 'Notices', test: (i) => i.kind === 'alert' || i.kind === 'rating' },
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
    el.scrollIntoView({ block: 'center' });
    el.classList.add('animate-flash');
    const t = setTimeout(() => el.classList.remove('animate-flash'), 2000);
    return () => clearTimeout(t);
  }, [hash, items.length]);

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
            {FILTERS.map((f) => (
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
                  <DeskItem item={item} />
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      {(closed.data?.items.length ?? 0) > 0 && (
        <details
          className="mt-8"
          data-testid="desk-closed"
          open={showClosed}
          onToggle={(e) => setShowClosed((e.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-fg">
            Answered and closed ({closed.data?.items.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-2">
            {closed.data?.items.map((i) => (
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
                  <EscalationTrail item={i} />
                </Panel>
              </li>
            ))}
          </ul>
        </details>
      )}
      <ChatDrawer open={chatOpen} onOpenChange={setChatOpen} />
    </div>
  );
}

/** One desk item: who asks, what they were doing, the question, options and the answer form. */
export function DeskItem({ item, now }: { item: DeskItemDto; now?: number }) {
  const Icon = KIND_ICON[item.kind] ?? CircleHelp;
  return (
    <article
      id={`desk-item-${item.id}`}
      data-testid={`desk-item-${item.id}`}
      data-kind={item.kind}
      data-blocking={item.blocking}
      data-pinned={item.pinned}
      aria-label={item.title}
      className={cx(
        'rounded-card border border-line border-l-[3px] bg-surface p-4 shadow-sm sm:p-5',
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
          {item.card ? 'only the card owner can answer this.' : 'only the project owner can answer.'}
        </p>
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
    </article>
  );
}

/** Dismiss asks first: it closes the item without an answer and tells the asker. */
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
  const [optionId, setOptionId] = useState<string | null>(defaultOption(item));
  const [typed, setTyped] = useState('');
  const [choice, setChoice] = useState<LedgerChoiceKey>('decision');
  const [err, setErr] = useState('');
  const text = answerText(typed, optionId, item.options);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text) return setErr('Choose an option or write an answer');
    setErr('');
    answer.mutate(
      { id: item.id, body: { answer: text, ...(optionId ? { optionId } : {}), ledger: choiceFor(choice) } },
      { onSuccess: () => toast.success('Answer sent. The agent carries on.') },
    );
  };

  return (
    <form onSubmit={submit} aria-label="Answer" className="mt-4 flex flex-col gap-4" noValidate>
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
        <div className="flex flex-col-reverse gap-2 sm:flex-row [&>button]:max-sm:w-full">
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
  const nav = useNavigate();
  const resolve = useResolveDeskItem();
  const toast = useToast();
  // A curator's taste-rule proposal can be reworded before it is approved (the edited text is what taste.md gets).
  const [rule, setRule] = useState(item.body);
  const editable =
    item.kind === 'approval' && (item.subkind === 'taste_rule' || item.subkind === 'standing_order');
  const edited = editable && rule.trim() && rule.trim() !== item.body.trim() ? rule.trim() : undefined;
  const done = (msg: string) => ({ onSuccess: () => toast.success(msg) });
  return (
    <div className="mt-4 flex flex-col gap-3">
      {editable && (
        <TextArea
          label={item.subkind === 'standing_order' ? 'Standing order (editable)' : 'Rule (editable)'}
          value={rule}
          onChange={(e) => setRule(e.target.value)}
        />
      )}
      <ErrorBox error={resolve.error} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap [&>button]:max-sm:w-full">
        <DismissButton item={item} />
        {item.kind === 'approval' ? (
          <>
            <Button
              onClick={() =>
                resolve.mutate({ id: item.id, body: { resolution: 'rejected' } }, done('Rejected'))
              }
            >
              Reject
            </Button>
            <Button
              variant="primary"
              loading={resolve.isPending}
              onClick={() =>
                resolve.mutate(
                  {
                    id: item.id,
                    body: { resolution: 'approved', ...(edited ? { editedBody: edited } : {}) },
                  },
                  done('Approved'),
                )
              }
            >
              {item.subkind === 'large_merge'
                ? 'Approve merge'
                : item.subkind === 'repo_create'
                  ? 'Create repository'
                  : 'Approve'}
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
          Approving merges into the working branch. It cannot be undone from here.
        </p>
      )}
    </div>
  );
}
