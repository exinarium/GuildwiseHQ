import { Archive as ArchiveIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAgents } from '../api/queries/agents.ts';
import { type ArchiveFilters, useArchive } from '../api/queries/archive.ts';
import { useProjects } from '../api/queries/projects.ts';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Select,
  TextInput,
} from '../components/ui.tsx';
import { priorityLabel } from '../lib/priority.ts';
import { formatDateTime } from '../lib/time.ts';

/** The cards that left the board: done or cancelled more than a day ago. Searchable; each card still opens and can be reopened. */
export function Archive() {
  const { projectKey = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.key === projectKey);
  const agents = useAgents(project?.id);
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [agentId, setAgentId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const filters: ArchiveFilters = {
    ...(text.trim() ? { q: text.trim() } : {}),
    ...(status ? { status: status as 'done' | 'cancelled' } : {}),
    ...(agentId ? { agentId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    page,
  };
  const archive = useArchive(project?.id, filters);
  // any change of a filter starts again at the first page
  const change = (set: (v: string) => void) => (v: string) => {
    set(v);
    setPage(1);
  };
  const data = archive.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  if (projects.isPending) return <PageHeader title="Archive" />;
  if (!project)
    return (
      <>
        <PageHeader title="Archive" />
        <EmptyState
          icon={ArchiveIcon}
          tone="warning"
          title="That project does not exist or you do not have access"
          description={`Nothing is called ${projectKey}.`}
        />
      </>
    );

  return (
    <div>
      <PageHeader
        title={`${project.name} archive`}
        documentTitle={`${project.name} archive`}
        back={{ to: `/p/${project.key}/board`, label: 'Back to the board' }}
        sub="Done and cancelled cards leave the board a day after they were finished. Open one to read it or to reopen it."
      />
      <form
        role="search"
        aria-label="Search the archive"
        className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(e) => e.preventDefault()}
      >
        <TextInput
          label="Search"
          type="search"
          placeholder="Reference, title or ticket key"
          value={text}
          onChange={(e) => change(setText)(e.target.value)}
        />
        <Select label="Status" value={status} onChange={(e) => change(setStatus)(e.target.value)}>
          <option value="">Done and cancelled</option>
          <option value="done">Done</option>
          <option value="cancelled">Cancelled</option>
        </Select>
        <Select label="Agent" value={agentId} onChange={(e) => change(setAgentId)(e.target.value)}>
          <option value="">Any agent</option>
          {(agents.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <TextInput
          label="Finished from"
          type="date"
          value={from}
          onChange={(e) => change(setFrom)(e.target.value)}
        />
        <TextInput
          label="Finished until"
          type="date"
          value={to}
          onChange={(e) => change(setTo)(e.target.value)}
        />
      </form>
      {archive.isError && <ErrorBox error={archive.error} onRetry={() => archive.refetch()} />}
      {archive.isPending && <ListSkeleton />}
      {data && data.cards.length === 0 && (
        <EmptyState
          icon={ArchiveIcon}
          title={
            data.total === 0 && !text && !status && !agentId && !from && !to
              ? 'Nothing archived yet'
              : 'No card matches'
          }
          description={
            data.total === 0 && !text && !status && !agentId && !from && !to
              ? 'Cards appear here a day after they are done or cancelled.'
              : 'Change the search or the filters.'
          }
        />
      )}
      {data && data.cards.length > 0 && (
        <>
          <ul
            className="divide-y divide-line rounded-card border border-line bg-surface"
            data-testid="archive-list"
          >
            {data.cards.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                <Link to={`/cards/${c.ref}`} className="tnum font-medium text-brand-text hover:underline">
                  {c.ref}
                </Link>
                <span className="min-w-[10rem] flex-1 text-fg [overflow-wrap:anywhere]">{c.title}</span>
                {c.externalRef && <span className="tnum text-sm text-muted">{c.externalRef}</span>}
                <Badge tone={c.status === 'done' ? 'success' : 'neutral'}>{c.status}</Badge>
                <span className="text-sm text-muted">{priorityLabel(c.priority)}</span>
                {c.lastAgent && <span className="text-sm text-muted">{c.lastAgent}</span>}
                <span className="text-sm text-subtle" title={formatDateTime(c.finishedAt)}>
                  {formatDateTime(c.finishedAt)}
                </span>
              </li>
            ))}
          </ul>
          <nav
            aria-label="Archive pages"
            className="mt-3 flex items-center justify-between gap-2 text-sm text-muted"
          >
            <span data-testid="archive-count">
              {data.total} {data.total === 1 ? 'card' : 'cards'} · page {data.page} of {pages}
            </span>
            <span className="flex gap-2">
              <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </span>
          </nav>
        </>
      )}
    </div>
  );
}
