import type { DeskItemDto } from '@aom/shared';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAnswerDeskItem, useDesk, useDismissDeskItem, useResolveDeskItem } from '../api/queries/desk.ts';
import { ChatDrawer } from '../components/ChatDrawer.tsx';
import { DigestRating } from '../components/DigestRating.tsx';
import { LedgerForm } from '../components/LedgerForm.tsx';
import {
  Avatar,
  Badge,
  Button,
  ErrorBox,
  PageHeader,
  Panel,
  Select,
  Spinner,
  TextArea,
} from '../components/ui.tsx';
import {
  answerText,
  choiceFor,
  defaultOption,
  LEDGER_CHOICES,
  type LedgerChoiceKey,
  sortDeskItems,
} from '../lib/desk.ts';
import { ageLabel, formatDateTime } from '../lib/time.ts';

export function Desk() {
  const open = useDesk({ status: 'open' });
  const closed = useDesk({ status: 'closed' });
  const [chatOpen, setChatOpen] = useState(false);
  const [showLedger, setShowLedger] = useState(false);
  const { hash } = useLocation();

  const items = useMemo(() => sortDeskItems(open.data?.items ?? []), [open.data]);

  // `#desk-item-<id>` links (from a blocked card) scroll to the item once it is rendered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run when the list or the hash changes
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'center' });
  }, [hash, items.length]);

  if (open.isPending) return <Spinner label="Loading the desk" />;
  const counts = open.data?.counts ?? { open: 0, blocking: 0, urgent: 0 };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Decision desk"
        sub={
          <span data-testid="desk-counts">
            {counts.open} open · {counts.blocking} blocking
          </span>
        }
        actions={
          <>
            <Button onClick={() => setShowLedger((v) => !v)} aria-expanded={showLedger}>
              Add to ledger
            </Button>
            <Button variant="primary" onClick={() => setChatOpen(true)}>
              Chat
            </Button>
          </>
        }
      />
      <ErrorBox error={open.error} />
      {showLedger && (
        <Panel className="mb-3">
          <h2 className="mb-2 text-sm font-semibold">Add a requirement or standing order</h2>
          <LedgerForm />
        </Panel>
      )}
      {items.length === 0 && (
        <Panel>
          <p className="text-sm text-zinc-500" data-testid="desk-empty">
            Nothing is waiting on you.
          </p>
        </Panel>
      )}
      <ol className="flex flex-col gap-3" aria-label="Open items" data-testid="desk-list">
        {items.map((item) => (
          <li key={item.id}>
            <DeskItem item={item} />
          </li>
        ))}
      </ol>

      {(closed.data?.items.length ?? 0) > 0 && (
        <details className="mt-6" data-testid="desk-closed">
          <summary className="cursor-pointer text-sm font-medium text-zinc-600 dark:text-zinc-400">
            Answered and closed ({closed.data?.items.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {closed.data?.items.map((i) => (
              <li key={i.id} data-testid={`desk-closed-${i.id}`}>
                <Panel>
                  <p className="text-sm font-medium">{i.title}</p>
                  <p className="text-xs text-zinc-500">
                    {i.status}
                    {i.answeredByName ? ` by ${i.answeredByName}` : ''} · {formatDateTime(i.answeredAt)}
                  </p>
                  {i.answer && <p className="mt-1 text-sm whitespace-pre-wrap">{i.answer}</p>}
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
  return (
    <article
      id={`desk-item-${item.id}`}
      data-testid={`desk-item-${item.id}`}
      data-kind={item.kind}
      data-blocking={item.blocking}
      data-pinned={item.pinned}
      aria-label={item.title}
      className={`rounded-lg border bg-white p-3 dark:bg-zinc-900 ${
        item.urgent
          ? 'border-red-300 ring-1 ring-red-200 dark:border-red-900 dark:ring-red-950'
          : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
        {item.urgent && (
          <Badge tone="red" title="Pinned: needs you first">
            <span data-testid="urgent-badge">Urgent</span>
          </Badge>
        )}
        <Badge tone="violet">{item.subkind ?? item.kind}</Badge>
        <Badge tone={item.blocking ? 'red' : 'neutral'}>{item.blocking ? 'Blocking' : 'Non-blocking'}</Badge>
        <span data-testid="affected-count">
          Affects {item.affectedCount} {item.affectedCount === 1 ? 'card' : 'cards'}
        </span>
        <span title={formatDateTime(item.createdAt)}>· asked {ageLabel(item.createdAt, now)} ago</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        {item.askedBy.agentName && (
          <span className="inline-flex items-center gap-1.5 font-medium" data-testid="asked-by">
            <Avatar name={item.askedBy.agentName} size={20} />
            {item.askedBy.agentName}
            {item.askedBy.role && <span className="font-normal text-zinc-500">({item.askedBy.role})</span>}
          </span>
        )}
        {item.card && (
          <Link to={`/cards/${item.card.ref}`} className="underline" data-testid="item-card">
            {item.card.ref} {item.card.title}
          </Link>
        )}
      </div>
      {item.doing && (
        <p className="mt-1 text-xs text-zinc-500" data-testid="item-doing">
          Was doing: {item.doing}
        </p>
      )}
      <h2 className="mt-2 text-base font-semibold whitespace-pre-wrap">{item.title}</h2>
      {item.body && item.kind !== 'rating' && <p className="mt-1 text-sm whitespace-pre-wrap">{item.body}</p>}
      {item.kind === 'rating' && item.digestItems && (
        <DigestRating items={item.digestItems} canRate={item.status === 'open' && item.canAnswer} />
      )}

      {item.dedupEntries.length > 0 && (
        <div
          className="mt-2 rounded-md bg-amber-50 p-2 text-xs dark:bg-amber-950/40"
          data-testid="dedup-entries"
        >
          <p className="font-medium">The ledger already has similar entries:</p>
          <ul className="mt-1 list-disc pl-4">
            {item.dedupEntries.map((e) => (
              <li key={e.id}>
                <span className="font-medium">{e.title}</span> ({e.scope.replace('_', ' ')}):{' '}
                {e.body.replace(/\s+/g, ' ').slice(0, 200)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {item.status !== 'open' ? (
        <p className="mt-2 text-sm text-zinc-500">
          {item.status}
          {item.answer ? `: ${item.answer}` : ''}
        </p>
      ) : !item.canAnswer ? (
        <p className="mt-2 text-sm text-zinc-500" data-testid="read-only">
          Read only:{' '}
          {item.card ? 'only the card owner can answer this.' : 'only the project owner can answer.'}
        </p>
      ) : item.kind === 'question' || (item.kind === 'escalation' && item.subkind !== 'vault_conflict') ? (
        <AnswerForm item={item} />
      ) : (
        <ResolveButtons item={item} />
      )}
    </article>
  );
}

function AnswerForm({ item }: { item: DeskItemDto }) {
  const answer = useAnswerDeskItem();
  const dismiss = useDismissDeskItem();
  const [optionId, setOptionId] = useState<string | null>(defaultOption(item));
  const [typed, setTyped] = useState('');
  const [choice, setChoice] = useState<LedgerChoiceKey>('decision');
  const [err, setErr] = useState('');
  const text = answerText(typed, optionId, item.options);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text) return setErr('Choose an option or write an answer');
    setErr('');
    answer.mutate({
      id: item.id,
      body: { answer: text, ...(optionId ? { optionId } : {}), ledger: choiceFor(choice) },
    });
  };

  return (
    <form onSubmit={submit} aria-label="Answer" className="mt-3 flex flex-col gap-3" noValidate>
      {item.options.length > 0 && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">Options</legend>
          {item.options.map((o) => (
            <label
              key={o.id}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-zinc-200 p-2 text-sm dark:border-zinc-700"
            >
              <input
                type="radio"
                name={`option-${item.id}`}
                value={o.id}
                checked={optionId === o.id}
                onChange={() => setOptionId(o.id)}
                className="mt-0.5"
              />
              <span className="flex-1">
                {o.label}
                {o.description && <span className="block text-xs text-zinc-500">{o.description}</span>}
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
      <ErrorBox error={answer.error ?? dismiss.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={answer.isPending}>
          Answer
        </Button>
        <Button disabled={dismiss.isPending} onClick={() => dismiss.mutate(item.id)}>
          Dismiss
        </Button>
      </div>
    </form>
  );
}

function ResolveButtons({ item }: { item: DeskItemDto }) {
  const nav = useNavigate();
  const resolve = useResolveDeskItem();
  const dismiss = useDismissDeskItem();
  // A curator's taste-rule proposal can be reworded before it is approved (the edited text is what taste.md gets).
  const [rule, setRule] = useState(item.body);
  const editable =
    item.kind === 'approval' && (item.subkind === 'taste_rule' || item.subkind === 'standing_order');
  const edited = editable && rule.trim() && rule.trim() !== item.body.trim() ? rule.trim() : undefined;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {editable && (
        <TextArea
          label={item.subkind === 'standing_order' ? 'Standing order (editable)' : 'Rule (editable)'}
          value={rule}
          onChange={(e) => setRule(e.target.value)}
        />
      )}
      <ErrorBox error={resolve.error ?? dismiss.error} />
      <div className="flex flex-wrap gap-2">
        {item.kind === 'approval' ? (
          <>
            <Button
              variant="primary"
              onClick={() =>
                resolve.mutate({
                  id: item.id,
                  body: { resolution: 'approved', ...(edited ? { editedBody: edited } : {}) },
                })
              }
            >
              {item.subkind === 'large_merge' ? 'Approve merge' : 'Approve'}
            </Button>
            <Button onClick={() => resolve.mutate({ id: item.id, body: { resolution: 'rejected' } })}>
              Reject
            </Button>
          </>
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
              onClick={() => resolve.mutate({ id: item.id, body: { resolution: 'acknowledged' } })}
            >
              {item.subkind === 'vault_conflict' ? 'Conflict resolved, resume sync' : 'Acknowledge'}
            </Button>
          </>
        )}
        <Button onClick={() => dismiss.mutate(item.id)}>Dismiss</Button>
      </div>
    </div>
  );
}
