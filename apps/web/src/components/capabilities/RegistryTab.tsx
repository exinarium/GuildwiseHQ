import { useState } from 'react';
import { type RegistryItem, useCapabilities } from '../../api/queries/capabilities.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Callout, EmptyState, ErrorBox, ListSkeleton, Select, TextInput } from '../ui.tsx';
import { SourceBadge, UnusableBadge } from './badges.tsx';
import { ChatWithPersona } from './ChatWithPersona.tsx';
import { useOrgTerms } from '../../lib/terms.ts';
import { Reword } from '../Reword.tsx';

const KINDS = ['skill', 'persona', 'playbook'] as const;
const SOURCES = ['builtin', 'org-vault', 'project-repo', 'pack'] as const;
const SOURCE_OPTION = {
  builtin: 'Built-in',
  'org-vault': 'Organization vault',
  'project-repo': 'Project repository',
  pack: 'Pack',
} as const;

/** Every capability the organization's agents can be given, and where each comes from. */
export function RegistryTab() {
  const t = useOrgTerms();
  const projects = useProjects();
  const [projectId, setProjectId] = useState('');
  const q = useCapabilities(projectId ? { projectId } : {});
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [source, setSource] = useState('');
  const needle = search.trim().toLowerCase();
  const all = q.data?.items ?? [];
  const items = all.filter(
    (i) =>
      (!kind || i.kind === kind) &&
      (!source || i.source === source) &&
      (!needle ||
        `${i.key} ${i.name} ${i.description} ${(i.tags ?? []).join(' ')}`.toLowerCase().includes(needle)),
  );
  return (
    <div className="flex flex-col gap-3" data-testid="registry-tab">
      <div className="grid gap-3 sm:grid-cols-4">
        <TextInput
          label="Search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name, key or tag"
        />
        <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <Select label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {t.reword(SOURCE_OPTION[s])}
            </option>
          ))}
        </Select>
        <Select
          label="Project repository"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          hint="Also list this project's own capabilities."
        >
          <option value="">None</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.key}: {p.name}
            </option>
          ))}
        </Select>
      </div>
      {q.isPending && <ListSkeleton label="Loading the registry" rows={4} />}
      {q.isError && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {(q.data?.issues?.length ?? 0) > 0 && (
        <Callout tone="warning" data-testid="registry-issues">
          <p className="font-medium"><Reword>{'Some files in your vault could not be read'}</Reword></p>
          <ul className="mt-1 list-disc pl-5">
            {q.data?.issues?.map((i) => (
              <li key={`${i.path}:${i.message}`}>
                <code>{i.path}</code>: {i.message}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {q.data && (
        <p className="text-xs text-subtle">
          {items.length} of {all.length} capabilities.{' '}
          {q.data.indexedAt
            ? t.reword(`Vault last indexed ${formatDateTime(q.data.indexedAt)}.`)
            : t.reword('No workstation has reported the vault yet.')}
        </p>
      )}
      <ul className="flex flex-col gap-2" data-testid="registry-list">
        {items.map((i) => (
          <RegistryRow key={`${i.kind}:${i.key}:${i.source}:${i.projectId ?? ''}`} item={i} />
        ))}
      </ul>
      {q.data && items.length === 0 && (
        <EmptyState title="Nothing matches" description="Change the search or the filters." />
      )}
    </div>
  );
}

function RegistryRow({ item: i }: { item: RegistryItem }) {
  return (
    <li className="rounded-card border border-line bg-surface p-3" data-testid={`cap-${i.kind}-${i.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        {i.icon && (
          <span aria-hidden="true" className="text-lg">
            {i.icon}
          </span>
        )}
        <span className="font-medium text-fg">{i.name}</span>
        <code className="text-xs text-muted">{i.key}</code>
        <Badge>{i.kind}</Badge>
        <SourceBadge source={i.source} pack={i.pack} />
        {i.overrides && (
          <Badge tone="violet" title="Replaces an entry of lower precedence with the same key">
            overrides
          </Badge>
        )}
        {i.visibility === 'private' && (
          <Badge
            tone="violet"
            data-testid="private-badge"
            title="Only you see this: it lives on your workstation"
          >
            private to you
          </Badge>
        )}
        <UnusableBadge usable={i.usable} reason={i.unusableReason} />
        {i.kind === 'persona' && i.usable !== false && (
          <span className="ml-auto">
            <ChatWithPersona personaKey={i.key} name={i.name} />
          </span>
        )}
        {i.hasScripts && (
          <Badge tone="amber" title="The pack ships script files. They stay off unless you enable them.">
            has scripts
          </Badge>
        )}
        {(i.tags ?? []).map((t) => (
          <Badge key={t} tone="neutral">
            {t}
          </Badge>
        ))}
      </div>
      {i.description && <p className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">{i.description}</p>}
    </li>
  );
}
