import { BookOpen, Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/client.ts';
import {
  useEditLedgerEntry,
  useLedger,
  useLedgerHistory,
  useRetireLedgerEntry,
  useReviewLedgerEntry,
} from '../api/queries/ledger.ts';
import { useProjects } from '../api/queries/projects.ts';
import { FullPowerControl } from '../components/ceo/FullPowerControl.tsx';
import { EnforcedByBadge } from '../components/EnforcedByBadge.tsx';
import { LedgerForm } from '../components/LedgerForm.tsx';
import { RulePacksDialog } from '../components/RulePacksDialog.tsx';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorBox,
  FilterChip,
  ListSkeleton,
  PageHeader,
  Select,
  TextArea,
  TextInput,
  useToast,
} from '../components/ui.tsx';
import { useBusinessMode } from '../lib/orgMode.ts';
import { useActiveOrgRole } from '../lib/orgRole.ts';
import { useOrgTerms } from '../lib/terms.ts';
import { formatCalendarDate, formatDateTime } from '../lib/time.ts';

const SCOPES = [
  { value: 'all', label: 'All' },
  { value: 'standing_order', label: 'Standing orders' },
  { value: 'decision', label: 'Decisions' },
  { value: 'feature', label: 'Requirements' },
] as const;

const scopeLabel = (s: string, reword: (v: string) => string = (v) => v) => {
  const label = SCOPES.find((x) => x.value === s)?.label.replace(/s$/, '');
  return label ? reword(label) : s;
};

type LedgerEntry = NonNullable<ReturnType<typeof useLedger>['data']>[number];

/** Edit form of a standing order: the earlier wording stays in the history. */
function EditForm({ e, onDone }: { e: LedgerEntry; onDone: () => void }) {
  const toast = useToast();
  const t = useOrgTerms();
  const edit = useEditLedgerEntry(e.id);
  const [title, setTitle] = useState(e.title);
  const [body, setBody] = useState(e.body);
  const [err, setErr] = useState('');
  const [keep, setKeep] = useState(false);
  const hasPower = e.fullPower?.state === 'authorized' && e.fullPower.current;
  const isOwner = useActiveOrgRole() === 'owner';
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!title.trim() || !body.trim()) return setErr('A title and the text are required');
    if (title.trim() === e.title && body.trim() === e.body) return onDone();
    setErr('');
    edit.mutate(
      {
        title: title.trim(),
        body: body.trim(),
        ...(hasPower && isOwner && keep ? { keepFullPower: true } : {}),
      },
      {
        onSuccess: () => {
          toast.success(t.reword('Standing order updated'));
          onDone();
        },
      },
    );
  };
  return (
    <form
      onSubmit={submit}
      aria-label={t.reword('Edit standing order')}
      className="flex flex-col gap-4"
      noValidate
    >
      <TextInput label="Title" value={title} onChange={(ev) => setTitle(ev.target.value)} />
      <TextArea label="Text" value={body} onChange={(ev) => setBody(ev.target.value)} error={err} />
      {hasPower && (
        <div className="flex flex-col gap-1" data-testid="fp-edit-note">
          <p className="text-sm text-muted">
            The CEO enforces this order with full power. Changing the wording voids that, unless the Owner
            keeps it.
          </p>
          {isOwner && (
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                className="size-4"
                checked={keep}
                onChange={(ev) => setKeep(ev.target.checked)}
              />
              Keep full power for the new wording
            </label>
          )}
        </div>
      )}
      <ErrorBox error={edit.error} />
      <Button type="submit" variant="primary" loading={edit.isPending} className="self-start">
        Save changes
      </Button>
    </form>
  );
}

/** Retire form: a reason is required; the entry stays in the ledger greyed out and agents stop seeing it. */
function RetireForm({ e, onDone }: { e: LedgerEntry; onDone: () => void }) {
  const toast = useToast();
  const t = useOrgTerms();
  const retire = useRetireLedgerEntry(e.id);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!reason.trim()) return setErr('Say why it is retired');
    setErr('');
    retire.mutate(
      { reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success('Entry retired');
          onDone();
        },
      },
    );
  };
  return (
    <form onSubmit={submit} aria-label="Retire entry" className="flex flex-col gap-4" noValidate>
      <p className="text-sm text-muted">
        {`"${e.title}" `}
        {t.reword(
          'stays in the ledger for the record, but agents no longer see it and a search no longer finds it.',
        )}
      </p>
      <TextArea label="Reason" value={reason} onChange={(ev) => setReason(ev.target.value)} error={err} />
      <ErrorBox error={retire.error} />
      <Button type="submit" variant="primary" loading={retire.isPending} className="self-start">
        Retire
      </Button>
    </form>
  );
}

/**
 * Review date of an entry: `set` saves, changes or removes it; `confirm` (an entry that is due) keeps the entry with a
 * later date or none, so the "review due" marker goes.
 */
function ReviewDateForm({
  e,
  mode,
  onDone,
}: {
  e: LedgerEntry;
  mode: 'set' | 'confirm';
  onDone: () => void;
}) {
  const toast = useToast();
  const edit = useEditLedgerEntry(e.id);
  const confirm = useReviewLedgerEntry(e.id);
  const m = mode === 'set' ? edit : confirm;
  const [date, setDate] = useState(mode === 'set' ? (e.reviewDate ?? '') : '');
  const [err, setErr] = useState('');
  const dateErr = m.error instanceof ApiError && m.error.code === 'review_date_past' ? m.error.message : '';
  const send = (reviewDate: string | null, done: string) => {
    setErr('');
    const opts = {
      onSuccess: () => {
        toast.success(done);
        onDone();
      },
    };
    if (mode === 'set') edit.mutate({ reviewDate }, opts);
    else confirm.mutate({ reviewDate }, opts);
  };
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (mode === 'set' && !date) return setErr('Pick a date, or remove the review date');
    send(date || null, mode === 'set' ? 'Review date saved' : 'Entry confirmed');
  };
  return (
    <form
      onSubmit={submit}
      aria-label={mode === 'set' ? 'Review date' : 'Confirm review'}
      className="flex flex-col gap-4"
      noValidate
    >
      <TextInput
        type="date"
        label={mode === 'set' ? 'Review date' : 'Next review date (optional)'}
        hint={
          mode === 'confirm'
            ? 'Leave empty for no further review. The entry stays as it is.'
            : 'Agents keep following the entry after this date; it is only marked for you to look at again.'
        }
        value={date}
        onChange={(ev) => setDate(ev.target.value)}
        error={err || dateErr || undefined}
      />
      {!dateErr && <ErrorBox error={m.error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={m.isPending}>
          {mode === 'set' ? 'Save' : 'Confirm'}
        </Button>
        {mode === 'set' && e.reviewDate && (
          <Button type="button" onClick={() => send(null, 'Review date removed')}>
            Remove review date
          </Button>
        )}
      </div>
    </form>
  );
}

/** Every wording of an entry, newest first. */
function History({ id }: { id: string }) {
  const h = useLedgerHistory(id, true);
  if (h.isPending) return <p className="mt-2 text-sm text-subtle">Loading the history...</p>;
  if (h.error) return <ErrorBox error={h.error} onRetry={() => h.refetch()} />;
  return (
    <ol data-testid="ledger-history" className="mt-2 flex flex-col gap-2 border-l-2 border-line pl-3">
      {h.data?.versions.map((v) => (
        <li key={v.version} className="text-sm">
          <p className="text-xs text-subtle">
            Version {v.version}
            {v.current ? ' (current)' : ''} · {v.savedByName ?? 'unknown'} · {formatDateTime(v.savedAt)}
          </p>
          <p className="font-medium text-fg">{v.title}</p>
          <p className="whitespace-pre-wrap text-muted">{v.body}</p>
        </li>
      ))}
    </ol>
  );
}

function Entry({ e }: { e: LedgerEntry }) {
  const t = useOrgTerms();
  const business = useBusinessMode();
  const [more, setMore] = useState(false);
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [reviewing, setReviewing] = useState<'set' | 'confirm' | null>(null);
  const retired = !!e.retiredAt;
  const long = e.body.length > 260 || e.body.split('\n').length > 4;
  return (
    <li
      data-testid="ledger-entry"
      data-scope={e.scope}
      data-retired={retired ? 'true' : undefined}
      className={`px-4 py-4 ${retired ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
        <Badge tone={e.scope === 'standing_order' ? 'amber' : e.scope === 'decision' ? 'blue' : 'violet'}>
          {scopeLabel(e.scope, t.reword)}
        </Badge>
        {business && e.scope === 'standing_order' && (
          <EnforcedByBadge value={e.enforcedBy ?? 'agent_instruction'} />
        )}
        {business && e.rulePack && <span data-testid="ledger-rule-pack">from {e.rulePack.name}</span>}
        {e.projectKey ? <span className="font-mono">{e.projectKey}</span> : <span>every project</span>}
        {e.cardRef && (
          <Link to={`/cards/${e.cardRef}`} className="font-mono text-brand-text hover:underline">
            {e.cardRef}
          </Link>
        )}
        <span>
          {e.createdByName ?? e.createdByKind} · {formatDateTime(e.createdAt)}
        </span>
        {retired && (
          <Badge tone="neutral">
            <span data-testid="ledger-retired">Retired</span>
          </Badge>
        )}
        {(e.conflictsWith ?? []).length > 0 && !retired && (
          <Badge tone="amber">
            <span data-testid="ledger-conflict">May contradict another order</span>
          </Badge>
        )}
        {e.reviewDate && (
          <span data-testid="ledger-review-date">review {formatCalendarDate(e.reviewDate)}</span>
        )}
        {e.reviewDue && !retired && (
          <Badge tone="amber">
            <span data-testid="ledger-review-due">Review due</span>
          </Badge>
        )}
        {e.version > 1 && e.editedAt && (
          <span data-testid="ledger-edited">
            edited {formatDateTime(e.editedAt)}
            {e.editedByName ? ` by ${e.editedByName}` : ''}
          </span>
        )}
      </div>
      <h2 className="mt-1.5 text-lg font-semibold text-fg">{e.title}</h2>
      <p className={`mt-1 text-base whitespace-pre-wrap text-muted ${more ? '' : 'line-clamp-3'}`}>
        {e.body}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setMore((v) => !v)}
          aria-expanded={more}
          className="mt-1 text-sm font-medium text-brand-text hover:underline"
        >
          {more ? 'Show less' : 'Show more'}
        </button>
      )}
      {retired && e.retiredReason && (
        <p className="mt-1 text-sm text-subtle" data-testid="ledger-retired-reason">
          Retired{e.retiredAt ? ` ${formatDateTime(e.retiredAt)}` : ''}: {e.retiredReason}
        </p>
      )}
      {!retired && e.canRetire && (
        <div className="mt-2 flex flex-wrap gap-2">
          {e.reviewDue && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => setReviewing('confirm')}
              aria-label={`Confirm ${e.title}`}
            >
              Confirm
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setReviewing('set')}
            aria-label={`Review date of ${e.title}`}
          >
            Review date
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRetiring(true)}
            aria-label={`Retire ${e.title}`}
          >
            Retire
          </Button>
        </div>
      )}
      {e.scope === 'standing_order' && !retired && (e.canEdit || e.version > 1) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {e.canEdit && (
            <Button size="sm" onClick={() => setEditing(true)} aria-label={`Edit ${e.title}`}>
              Edit
            </Button>
          )}
          {e.version > 1 && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={history}
              onClick={() => setHistory((v) => !v)}
              aria-label={`History of ${e.title}`}
            >
              {history ? 'Hide history' : `History (${e.version} versions)`}
            </Button>
          )}
        </div>
      )}
      <FullPowerControl e={e} />
      {history && <History id={e.id} />}
      <Dialog
        open={retiring}
        onOpenChange={setRetiring}
        title="Retire entry"
        description="Use this for a one-off order, a duplicate or a rule that a setting replaced."
      >
        <RetireForm e={e} onDone={() => setRetiring(false)} />
      </Dialog>
      <Dialog
        open={reviewing !== null}
        onOpenChange={(o) => !o && setReviewing(null)}
        title={reviewing === 'confirm' ? 'Confirm entry' : 'Review date'}
        description={
          reviewing === 'confirm'
            ? 'Keep this entry as it is and set when to look at it again. To change the wording or withdraw it, use Edit or Retire.'
            : 'When you want to look at this entry again.'
        }
      >
        {reviewing && <ReviewDateForm e={e} mode={reviewing} onDone={() => setReviewing(null)} />}
      </Dialog>
      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title={t.reword('Edit standing order')}
        description="Agents get the new wording from their next shift or chat. The earlier wording stays in the history."
      >
        <EditForm e={e} onDone={() => setEditing(false)} />
      </Dialog>
    </li>
  );
}

export function Ledger() {
  const t = useOrgTerms();
  const projects = useProjects();
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<(typeof SCOPES)[number]['value']>('all');
  const [projectId, setProjectId] = useState('');
  const [adding, setAdding] = useState(false);
  const business = useBusinessMode();
  const [packs, setPacks] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [dueOnly, setDueOnly] = useState(false);
  const entries = useLedger({
    ...(q.trim() ? { q: q.trim() } : {}),
    scope,
    includeRetired: showRetired,
    due: dueOnly,
    ...(projectId ? { projectId } : {}),
  });
  const filtered = !!q.trim() || scope !== 'all' || !!projectId || dueOnly;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={t.ledger}
        sub={t.reword('Requirements, decisions and standing orders agents rely on')}
        actions={
          <>
            {business && (
              <Button variant="secondary" onClick={() => setPacks(true)}>
                Rule packs
              </Button>
            )}
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add entry
            </Button>
          </>
        }
      />
      <search aria-label={t.reword('Search the ledger')} className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="relative min-w-0 flex-1 basis-60">
            <Search
              aria-hidden="true"
              className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
            />
            <input
              type="search"
              aria-label="Search"
              placeholder="Search: tabs, cookies, ..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQ('')}
              className="h-9 w-full rounded-control border border-control bg-surface pr-3 pl-9 text-base text-fg placeholder:text-subtle focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:outline-none [@media(pointer:coarse)]:h-11"
            />
          </div>
          <div className="w-44">
            <Select label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">All projects</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.key}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Scope">
          {SCOPES.map((s) => (
            <FilterChip key={s.value} pressed={scope === s.value} onClick={() => setScope(s.value)}>
              {t.reword(s.label)}
            </FilterChip>
          ))}
          <FilterChip pressed={showRetired} onClick={() => setShowRetired((v) => !v)}>
            Show retired
          </FilterChip>
          <FilterChip pressed={dueOnly} onClick={() => setDueOnly((v) => !v)}>
            Due for review
          </FilterChip>
        </div>
      </search>
      {entries.isPending && <ListSkeleton label={t.reword('Loading the ledger')} />}
      <ErrorBox error={entries.error} onRetry={() => entries.refetch()} />
      {entries.data?.length === 0 &&
        (filtered ? (
          <EmptyState
            data-testid="ledger-empty"
            icon={Search}
            tone="neutral"
            title={q.trim() ? `No entries match "${q.trim()}"` : 'No entries match these filters'}
            action={
              <Button
                onClick={() => {
                  setQ('');
                  setScope('all');
                  setProjectId('');
                  setDueOnly(false);
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            data-testid="ledger-empty"
            icon={BookOpen}
            title={t.reword('The ledger is empty')}
            description="Answers you give on the desk are recorded here so agents do not ask twice."
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add an entry
              </Button>
            }
          />
        ))}
      {(entries.data?.length ?? 0) > 0 && (
        <ul
          className="divide-y divide-line rounded-card border border-line bg-surface"
          data-testid="ledger-list"
        >
          {entries.data?.map((e) => (
            <Entry key={e.id} e={e} />
          ))}
        </ul>
      )}
      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title={t.reword('Add to the ledger')}
        description={t.reword(
          'A standing order is loaded by every agent. Requirements and decisions belong to a project.',
        )}
      >
        <LedgerForm onDone={() => setAdding(false)} />
      </Dialog>
      {business && <RulePacksDialog open={packs} onOpenChange={setPacks} />}
    </div>
  );
}
