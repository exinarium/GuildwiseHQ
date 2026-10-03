import { useState } from 'react';
import { Link } from 'react-router';
import { useLedger } from '../api/queries/ledger.ts';
import { useProjects } from '../api/queries/projects.ts';
import { LedgerForm } from '../components/LedgerForm.tsx';
import { Badge, ErrorBox, PageHeader, Panel, Select, Spinner, TextInput } from '../components/ui.tsx';
import { formatDateTime } from '../lib/time.ts';

const SCOPES = [
  { value: 'all', label: 'All entries' },
  { value: 'standing_order', label: 'Standing orders' },
  { value: 'decision', label: 'Decisions' },
  { value: 'feature', label: 'Requirements' },
] as const;

const scopeLabel = (s: string) => SCOPES.find((x) => x.value === s)?.label.replace(/s$/, '') ?? s;

export function Ledger() {
  const projects = useProjects();
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<(typeof SCOPES)[number]['value']>('all');
  const [projectId, setProjectId] = useState('');
  const entries = useLedger({
    ...(q.trim() ? { q: q.trim() } : {}),
    scope,
    ...(projectId ? { projectId } : {}),
  });

  return (
    <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <PageHeader title="Ledger" sub="Requirements, decisions and standing orders agents rely on" />
        <search aria-label="Search the ledger" className="mb-3 grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
          <TextInput
            label="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="tabs, cookies, ..."
          />
          <Select label="Scope" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            {SCOPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
          <Select label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All projects</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key}
              </option>
            ))}
          </Select>
        </search>
        {entries.isPending && <Spinner label="Loading the ledger" />}
        <ErrorBox error={entries.error} />
        {entries.data?.length === 0 && (
          <Panel>
            <p className="text-sm text-zinc-500" data-testid="ledger-empty">
              {q.trim() ? 'No entries match.' : 'The ledger is empty. Answers on the desk are recorded here.'}
            </p>
          </Panel>
        )}
        <ul className="flex flex-col gap-2" data-testid="ledger-list">
          {entries.data?.map((e) => (
            <li key={e.id} data-testid="ledger-entry" data-scope={e.scope}>
              <Panel>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                  <Badge
                    tone={e.scope === 'standing_order' ? 'amber' : e.scope === 'decision' ? 'blue' : 'violet'}
                  >
                    {scopeLabel(e.scope)}
                  </Badge>
                  {e.projectKey ? <span>{e.projectKey}</span> : <span>every project</span>}
                  {e.cardRef && (
                    <Link to={`/cards/${e.cardRef}`} className="underline">
                      {e.cardRef}
                    </Link>
                  )}
                  <span>
                    · {e.createdByName ?? e.createdByKind} · {formatDateTime(e.createdAt)}
                  </span>
                </div>
                <h2 className="mt-1 text-sm font-semibold">{e.title}</h2>
                <p className="mt-1 text-sm whitespace-pre-wrap">{e.body}</p>
              </Panel>
            </li>
          ))}
        </ul>
      </div>
      <aside>
        <Panel>
          <h2 className="mb-2 text-sm font-semibold">Add to the ledger</h2>
          <LedgerForm />
        </Panel>
      </aside>
    </div>
  );
}
