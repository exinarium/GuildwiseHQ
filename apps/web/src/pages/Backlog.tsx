import {
  BACKLOG_PRIORITY_LABEL,
  BACKLOG_STATUS_LABEL,
  type BacklogItemDto,
  type BacklogPriority,
  BacklogPriority as BacklogPrioritySchema,
  type BacklogSendResult,
} from '@aom/shared';
import { ListTodo, MoreHorizontal, Star } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { errorMessage } from '../api/client.ts';
import { useMe } from '../api/queries/auth.ts';
import {
  type BacklogQuery,
  useAddBacklogItem,
  useBacklog,
  useDropBacklogItem,
  useEditBacklogItem,
  useSendBacklog,
} from '../api/queries/backlog.ts';
import { useProjects } from '../api/queries/projects.ts';
import { ProjectTabs } from '../components/ProjectTabs.tsx';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  FilterChip,
  ListSkeleton,
  Menu,
  MenuItem,
  PageHeader,
  Select,
  TextArea,
  TextInput,
  useToast,
} from '../components/ui.tsx';

const PRIORITIES = BacklogPrioritySchema.options;
const STATUSES = ['open', 'done', 'dropped'] as const;
const PRIORITY_TONE = { critical: 'danger', high: 'warning', normal: 'neutral', low: 'info' } as const;

const parseTags = (s: string): string[] => [
  ...new Set(
    s
      .split(/[,\n]/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  ),
];

function SourceLabel({ item }: { item: BacklogItemDto }) {
  if (item.source.kind === 'owner') return <span>You</span>;
  return (
    <span data-testid="backlog-source">
      {item.source.agentName}
      {item.source.cardRef && (
        <>
          {' on '}
          <Link to={`/cards/${item.source.cardRef}`} className="tnum text-brand-text hover:underline">
            {item.source.cardRef}
          </Link>
        </>
      )}
    </span>
  );
}

function EditDialog({ item, onClose }: { item: BacklogItemDto; onClose: () => void }) {
  const edit = useEditBacklogItem();
  const toast = useToast();
  const readOnly = item.status !== 'open';
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [priority, setPriority] = useState<BacklogPriority>(item.priority);
  const [tags, setTags] = useState(item.tags.join(', '));
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    edit.mutate(
      { id: item.id, patch: { title: title.trim(), description, priority, tags: parseTags(tags) } },
      {
        onSuccess: () => {
          toast.success('Saved');
          onClose();
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={readOnly ? 'Backlog item' : 'Edit backlog item'}
      footer={
        readOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" form="backlog-edit" loading={edit.isPending}>
              Save
            </Button>
          </>
        )
      }
    >
      <form id="backlog-edit" onSubmit={save} className="space-y-3">
        <TextInput
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={readOnly}
          maxLength={300}
        />
        <TextArea
          label="Description (what we want)"
          rows={6}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={readOnly}
        />
        <Select
          label="Priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value as BacklogPriority)}
          disabled={readOnly}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {BACKLOG_PRIORITY_LABEL[p]}
            </option>
          ))}
        </Select>
        <TextInput
          label="Tags"
          hint="Separate tags with commas"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          disabled={readOnly}
        />
        <p className="text-sm text-muted">
          Source: <SourceLabel item={item} />
          {item.cardRef && (
            <>
              {' · Became '}
              <Link to={`/cards/${item.cardRef}`} className="tnum text-brand-text hover:underline">
                {item.cardRef}
              </Link>
            </>
          )}
        </p>
      </form>
    </Dialog>
  );
}

/** The project's backlog: wanted work that is not in development. Nothing here is worked until it is sent to the BA. */
export function Backlog() {
  const { projectKey = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.key === projectKey);
  const me = useMe();
  const role = me.data?.activeOrg?.role;
  const canManage = role === 'owner' || role === 'admin';
  const toast = useToast();

  const [text, setText] = useState('');
  const [statuses, setStatuses] = useState<string[]>(['open']);
  const [flagged, setFlagged] = useState(false);
  const [source, setSource] = useState<'' | 'owner' | 'agent'>('');
  const [priority, setPriority] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState<'priority' | 'created'>('priority');
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<BacklogItemDto | null>(null);
  const [dropping, setDropping] = useState<BacklogItemDto | null>(null);
  const [failed, setFailed] = useState<BacklogSendResult[]>([]);

  const query: BacklogQuery = {
    status: statuses,
    ...(priority ? { priority: [priority] } : {}),
    ...(tag ? { tag: [tag] } : {}),
    ...(flagged ? { flagged: true } : {}),
    ...(source ? { source } : {}),
    ...(text.trim() ? { q: text.trim() } : {}),
    sort,
  };
  const list = useBacklog(project?.id, query);
  const add = useAddBacklogItem(project?.id);
  const edit = useEditBacklogItem();
  const drop = useDropBacklogItem();
  const send = useSendBacklog();

  const toggleStatus = (s: string) =>
    setStatuses((cur) => {
      const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
      return next.length ? next : cur;
    });

  const quickAdd = (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    add.mutate(
      { title: t },
      {
        onSuccess: () => setTitle(''),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const sendItems = (ids: string[]) =>
    send.mutate(ids, {
      onSuccess: ({ results }) => {
        const ok = results.filter((r) => r.ok);
        const bad = results.filter((r) => !r.ok);
        if (ok.length) {
          const note = ok.find((r) => r.note)?.note;
          toast.success(
            ok.length === 1
              ? `Sent: ${ok[0]?.cardRef}${note ? `. ${note}` : ''}`
              : `${ok.length} sent: ${ok.map((r) => r.cardRef).join(', ')}`,
          );
        }
        setFailed(bad);
        setSelected(bad.map((r) => r.itemId));
        if (bad.length && results.length === 1) toast.error(bad[0]?.error ?? 'Could not send');
      },
      onError: (err) => toast.error(errorMessage(err)),
    });

  if (projects.isPending) return <PageHeader title="Backlog" />;
  if (!project)
    return (
      <>
        <PageHeader title="Backlog" />
        <EmptyState
          icon={ListTodo}
          tone="warning"
          title="That project does not exist or you do not have access"
          description={`Nothing is called ${projectKey}.`}
        />
      </>
    );

  const items = list.data?.items ?? [];
  const selectable = items.filter((i) => i.status === 'open').map((i) => i.id);
  const chosen = selected.filter((id) => selectable.includes(id));
  const filtered = statuses.join() !== 'open' || flagged || source || priority || tag || text.trim();

  return (
    <div className="pb-20 md:pb-0">
      <PageHeader
        title={project.name}
        documentTitle={`${project.name} backlog`}
        sub="Wanted work, kept out of development. Nothing here is worked until you send it to the BA."
      />
      <ProjectTabs projectKey={project.key} active="backlog" />

      {canManage && (
        <form onSubmit={quickAdd} className="mb-4 flex items-end gap-2" aria-label="Quick add">
          <div className="min-w-0 flex-1">
            <TextInput
              label="Add to the backlog"
              placeholder="Type a title and press Enter"
              enterKeyHint="done"
              autoComplete="off"
              maxLength={300}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <Button type="submit" variant="primary" disabled={!title.trim()} loading={add.isPending}>
            Add
          </Button>
        </form>
      )}

      <div className="mb-4 space-y-3" role="search" aria-label="Search and filter the backlog">
        <TextInput
          label="Search the backlog"
          type="search"
          placeholder="Title, description or tag"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip pressed={flagged} onClick={() => setFlagged((v) => !v)}>
            Flagged
          </FilterChip>
          <FilterChip
            pressed={source === 'agent'}
            onClick={() => setSource((s) => (s === '' ? 'agent' : s === 'agent' ? 'owner' : ''))}
          >
            {source === 'owner' ? 'Owner items' : 'Agent suggestions'}
          </FilterChip>
          {STATUSES.map((s) => (
            <FilterChip key={s} pressed={statuses.includes(s)} onClick={() => toggleStatus(s)}>
              {BACKLOG_STATUS_LABEL[s]}
            </FilterChip>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">Any priority</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {BACKLOG_PRIORITY_LABEL[p]}
              </option>
            ))}
          </Select>
          <Select label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Any tag</option>
            {(list.data?.tags ?? []).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Select
            label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as 'priority' | 'created')}
          >
            <option value="priority">Priority</option>
            <option value="created">Newest</option>
          </Select>
        </div>
      </div>

      {failed.length > 0 && (
        <Callout
          tone="danger"
          role="alert"
          title={`${failed.length} could not be sent`}
          className="mb-4"
          actions={<Button onClick={() => setFailed([])}>Dismiss</Button>}
        >
          <ul className="list-disc pl-4">
            {failed.map((f) => (
              <li key={f.itemId}>
                {f.title}: {f.error}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {list.isError && <ErrorBox error={list.error} onRetry={() => list.refetch()} />}
      {list.isPending && <ListSkeleton />}
      {list.data && items.length === 0 && (
        <EmptyState
          icon={ListTodo}
          title={filtered ? 'No backlog item matches' : 'Nothing on the backlog'}
          description={
            filtered
              ? 'Change the search or the filters.'
              : canManage
                ? 'Type a title above and press Enter.'
                : 'Nothing has been added yet.'
          }
        />
      )}
      {items.length > 0 && (
        <ul
          className="divide-y divide-line rounded-card border border-line bg-surface"
          data-testid="backlog-list"
        >
          {items.map((i) => (
            <li
              key={i.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5"
              data-testid="backlog-row"
            >
              {canManage && i.status === 'open' ? (
                <input
                  type="checkbox"
                  className="size-5"
                  aria-label={`Select ${i.title}`}
                  checked={chosen.includes(i.id)}
                  onChange={(e) =>
                    setSelected((cur) => (e.target.checked ? [...cur, i.id] : cur.filter((x) => x !== i.id)))
                  }
                />
              ) : (
                <span className="size-5" aria-hidden="true" />
              )}
              {canManage && i.status === 'open' ? (
                <button
                  type="button"
                  aria-label={`Flag ${i.title}`}
                  aria-pressed={i.flagged}
                  className="inline-flex size-11 items-center justify-center rounded-control text-muted hover:bg-sunken"
                  onClick={() =>
                    edit.mutate(
                      { id: i.id, patch: { flagged: !i.flagged } },
                      { onError: (err) => toast.error(errorMessage(err)) },
                    )
                  }
                >
                  <Star
                    aria-hidden="true"
                    className={i.flagged ? 'size-5 fill-current text-warning' : 'size-5'}
                  />
                </button>
              ) : (
                i.flagged && <Star aria-label="Flagged" className="size-5 fill-current text-warning" />
              )}
              <button
                type="button"
                className="min-w-[10rem] flex-1 text-left font-medium text-fg [overflow-wrap:anywhere] hover:underline"
                onClick={() => setEditing(i)}
              >
                {i.title}
              </button>
              <Badge tone={PRIORITY_TONE[i.priority]}>{BACKLOG_PRIORITY_LABEL[i.priority]}</Badge>
              {i.tags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
              <span className="text-sm text-muted">
                <SourceLabel item={i} />
              </span>
              {i.status !== 'open' && (
                <Badge tone={i.status === 'done' ? 'success' : 'neutral'}>
                  {BACKLOG_STATUS_LABEL[i.status]}
                </Badge>
              )}
              {i.status === 'done' && i.cardRef && (
                <Link
                  to={`/cards/${i.cardRef}`}
                  className="tnum text-sm font-medium text-brand-text hover:underline"
                >
                  Became {i.cardRef}
                </Link>
              )}
              {canManage && i.status === 'open' && (
                <Menu
                  label={`Actions for ${i.title}`}
                  trigger={<MoreHorizontal aria-hidden="true" className="size-5" />}
                >
                  <MenuItem onSelect={() => setEditing(i)}>Edit</MenuItem>
                  <MenuItem onSelect={() => sendItems([i.id])}>Send to BA</MenuItem>
                  <MenuItem danger onSelect={() => setDropping(i)}>
                    Drop
                  </MenuItem>
                </Menu>
              )}
            </li>
          ))}
        </ul>
      )}

      {chosen.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 border-t border-line bg-surface px-4 py-3 md:sticky md:rounded-card md:border">
          <span className="text-sm">{chosen.length} selected</span>
          <div className="flex gap-2">
            <Button onClick={() => setSelected([])}>Clear</Button>
            <Button variant="primary" loading={send.isPending} onClick={() => sendItems(chosen)}>
              Send {chosen.length} to the BA
            </Button>
          </div>
        </div>
      )}

      {editing && <EditDialog key={editing.id} item={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!dropping}
        onOpenChange={(o) => !o && setDropping(null)}
        title="Drop this item?"
        description={
          dropping
            ? `"${dropping.title}" leaves the backlog. You can still find it with the Dropped filter.`
            : undefined
        }
        confirmLabel="Drop"
        pending={drop.isPending}
        onConfirm={() =>
          dropping &&
          drop.mutate(dropping.id, {
            onSuccess: () => setDropping(null),
            onError: (err) => {
              toast.error(errorMessage(err));
              setDropping(null);
            },
          })
        }
      />
    </div>
  );
}
