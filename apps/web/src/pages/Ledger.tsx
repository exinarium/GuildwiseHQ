import { BookOpen, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useLedger } from '../api/queries/ledger.ts';
import { useProjects } from '../api/queries/projects.ts';
import { LedgerForm } from '../components/LedgerForm.tsx';
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
} from '../components/ui.tsx';
import { formatDateTime } from '../lib/time.ts';

const SCOPES = [
  { value: 'all', label: 'All' },
  { value: 'standing_order', label: 'Standing orders' },
  { value: 'decision', label: 'Decisions' },
  { value: 'feature', label: 'Requirements' },
] as const;

const scopeLabel = (s: string) => SCOPES.find((x) => x.value === s)?.label.replace(/s$/, '') ?? s;

function Entry({ e }: { e: NonNullable<ReturnType<typeof useLedger>['data']>[number] }) {
  const [more, setMore] = useState(false);
  const long = e.body.length > 260 || e.body.split('\n').length > 4;
  return (
    <li data-testid="ledger-entry" data-scope={e.scope} className="px-4 py-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
        <Badge tone={e.scope === 'standing_order' ? 'amber' : e.scope === 'decision' ? 'blue' : 'violet'}>
          {scopeLabel(e.scope)}
        </Badge>
        {e.projectKey ? <span className="font-mono">{e.projectKey}</span> : <span>every project</span>}
        {e.cardRef && (
          <Link to={`/cards/${e.cardRef}`} className="font-mono text-brand-text hover:underline">
            {e.cardRef}
          </Link>
        )}
        <span>
          {e.createdByName ?? e.createdByKind} · {formatDateTime(e.createdAt)}
        </span>
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
    </li>
  );
}

export function Ledger() {
  const projects = useProjects();
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<(typeof SCOPES)[number]['value']>('all');
  const [projectId, setProjectId] = useState('');
  const [adding, setAdding] = useState(false);
  const entries = useLedger({
    ...(q.trim() ? { q: q.trim() } : {}),
    scope,
    ...(projectId ? { projectId } : {}),
  });
  const filtered = !!q.trim() || scope !== 'all' || !!projectId;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Ledger"
        sub="Requirements, decisions and standing orders agents rely on"
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add entry
          </Button>
        }
      />
      <search aria-label="Search the ledger" className="mb-4 flex flex-col gap-3">
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
              {s.label}
            </FilterChip>
          ))}
        </div>
      </search>
      {entries.isPending && <ListSkeleton label="Loading the ledger" />}
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
            title="The ledger is empty"
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
        title="Add to the ledger"
        description="A standing order is loaded by every agent. Requirements and decisions belong to a project."
      >
        <LedgerForm onDone={() => setAdding(false)} />
      </Dialog>
    </div>
  );
}
