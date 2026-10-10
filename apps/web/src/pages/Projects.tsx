import type { ProjectDto } from '@aom/shared';
import { CreateProjectRequestSchema, workflowUsesRepos } from '@aom/shared';
import { Archive, Code2, FlaskConical, FolderKanban, Rss, Settings } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { errorMessage } from '../api/client.ts';
import { useWorkflows } from '../api/queries/agents.ts';
import { useMe } from '../api/queries/auth.ts';
import {
  useArchivedProjects,
  useCreateProject,
  useProjects,
  useRankProjects,
  useRestoreProject,
} from '../api/queries/projects.ts';
import { DeleteProjectDialog } from '../components/DeleteProjectDialog.tsx';
import { ProjectInvitations } from '../components/ProjectInvitations.tsx';
import { ProjectRankList } from '../components/ProjectRankList.tsx';
import { projectTypeLabel } from '../components/shell/ProjectSwitcher.tsx';
import { cx } from '../components/ui/cx.ts';
import { panelId, tabId } from '../components/ui/Tabs.tsx';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Select,
  Tabs,
  TextInput,
  useToast,
} from '../components/ui.tsx';
import { departmentsOf, inDepartment } from '../lib/designer.ts';

const TYPE_ICON = { code: Code2, research: FlaskConical, feed: Rss } as const;

function ProjectCard({ p, activeOrgId }: { p: ProjectDto; activeOrgId: string | null }) {
  const guest = !!activeOrgId && p.orgId !== activeOrgId;
  const Icon = TYPE_ICON[p.workflowKey as keyof typeof TYPE_ICON] ?? FolderKanban;
  return (
    <li className="group relative rounded-card border border-line bg-surface p-4 transition-shadow hover:border-control hover:shadow-md">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand-soft-fg">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <Link
            to={`/p/${p.key}/board`}
            className="block truncate text-lg font-semibold text-fg after:absolute after:inset-0 after:rounded-card"
          >
            {p.name}
          </Link>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
            <span className="font-mono font-semibold text-muted">{p.key}</span>
            <span aria-hidden="true">·</span>
            {projectTypeLabel(p.workflowKey)}
          </p>
        </div>
        <Link
          className="relative z-10 -mt-1 -mr-1 inline-flex size-10 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg"
          aria-label={`Settings for ${p.key}`}
          title="Project settings"
          to={`/projects/${p.id}/settings`}
        >
          <Settings aria-hidden="true" className="size-4" />
        </Link>
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge>{p.workflowKey}</Badge>
        {p.department && <Badge tone="violet">{p.department}</Badge>}
        {guest ? (
          <Badge tone="amber" title="You are a guest of this project's organization">
            Guest{p.orgName ? ` · ${p.orgName}` : ''}
          </Badge>
        ) : (
          <Badge tone={p.myRole === 'owner' ? 'blue' : 'neutral'}>
            {p.myRole === 'owner' ? 'owner' : 'shared with you'}
          </Badge>
        )}
      </p>
    </li>
  );
}

export function Projects() {
  const me = useMe();
  const canCreate = me.data?.activeOrg?.role === 'owner' || me.data?.activeOrg?.role === 'admin';
  const projects = useProjects();
  const archived = useArchivedProjects();
  const [showArchived, setShowArchived] = useState(false);
  // `/projects?new=1` (the Get started checklist) opens the New project form.
  const [params] = useSearchParams();
  const [open, setOpen] = useState(() => params.get('new') === '1' && canCreate);
  const [department, setDepartment] = useState('');
  const departments = departmentsOf(projects.data ?? []);
  const shown = inDepartment(projects.data ?? [], department);
  const rank = useRankProjects();
  const toast = useToast();
  const activeOrgId = me.data?.activeOrg?.id ?? null;
  // The organization's own projects are ranked; the ones shared by other organizations (a guest's) are not ours to order.
  const own = shown.filter((p) => !activeOrgId || p.orgId === activeOrgId);
  const shared = shown.filter((p) => !!activeOrgId && p.orgId !== activeOrgId);
  const ownAll = (projects.data ?? []).filter((p) => !activeOrgId || p.orgId === activeOrgId);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Projects"
        sub="Each project owns a board, its agents and, for code, its repositories."
        actions={
          canCreate && (
            <Button variant="primary" onClick={() => setOpen(true)}>
              New project
            </Button>
          )
        }
      />
      <ProjectInvitations />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Tabs
          label="Project filter"
          prefix="projects"
          value={showArchived ? 'archived' : 'active'}
          onChange={(v) => setShowArchived(v === 'archived')}
          className="mb-4 basis-full sm:flex-1 sm:basis-0"
          tabs={[
            { id: 'active', label: 'Active', testId: 'filter-active' },
            {
              id: 'archived',
              label: `Archived${archived.data && archived.data.length > 0 ? ` (${archived.data.length})` : ''}`,
              testId: 'filter-archived',
            },
          ]}
        />
        {departments.length > 0 && !showArchived && (
          <div className="mb-4 w-52">
            <Select label="Department" value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      <div
        role="tabpanel"
        id={panelId('projects', showArchived ? 'archived' : 'active')}
        aria-labelledby={tabId('projects', showArchived ? 'archived' : 'active')}
      >
        {showArchived && <ArchivedProjects />}
        {!showArchived && projects.isPending && <ListSkeleton label="Loading projects" />}
        {!showArchived && projects.isError && (
          <ErrorBox error={projects.error} onRetry={() => projects.refetch()} />
        )}
        {!showArchived && projects.data?.length === 0 && (
          <EmptyState
            icon={FolderKanban}
            title="No projects yet"
            description="A project is where the work happens: a board, a team of agents and, for code, its repositories. Create your first one to start."
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                Create your first project
              </Button>
            }
          />
        )}
        <div hidden={showArchived}>
          {own.length > 0 && (
            <section aria-labelledby="priority-heading" data-testid="ranked-projects">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2 id="priority-heading" className="text-base font-semibold text-fg">
                  Priority order
                </h2>
                <p className="text-sm text-muted">
                  The project at the top is served first: agents take the next card from the highest project
                  that has work.
                </p>
              </div>
              <ProjectRankList
                projects={own}
                canRank={canCreate}
                disabledReason={
                  canCreate && own.length < ownAll.length
                    ? 'Clear the department filter to change the order: it only makes sense for all projects.'
                    : undefined
                }
                onReorder={(ids) =>
                  rank.rank(ids).catch((e) => toast.error(`The order was not saved: ${errorMessage(e)}`))
                }
              />
            </section>
          )}
          {shared.length > 0 && (
            <section aria-labelledby="shared-heading" className={own.length > 0 ? 'mt-8' : ''}>
              <h2 id="shared-heading" className="mb-3 text-base font-semibold text-fg">
                Shared with you
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {shared.map((p) => (
                  <ProjectCard key={p.id} p={p} activeOrgId={activeOrgId} />
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      <NewProjectDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

/** Archived projects: Restore for any member, "Delete permanently" (type the key) for the project owner. */
function ArchivedProjects() {
  const archived = useArchivedProjects();
  const restore = useRestoreProject();
  const toast = useToast();
  const [deleting, setDeleting] = useState<ProjectDto | null>(null);
  return (
    <section aria-label="Archived projects" data-testid="archived-projects">
      {archived.isPending && <ListSkeleton label="Loading archived projects" rows={2} />}
      {archived.isError && <ErrorBox error={archived.error} onRetry={() => archived.refetch()} />}
      {archived.data?.length === 0 && (
        <EmptyState
          data-testid="archived-empty"
          icon={Archive}
          tone="neutral"
          title="No archived projects"
          description="Archiving a project stops its work and hides it from pickers. You can restore it here."
        />
      )}
      <ErrorBox error={restore.error} />
      <ul className="flex flex-col gap-2">
        {archived.data?.map((p) => (
          <li
            key={p.id}
            data-testid={`archived-${p.key}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-4"
          >
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold text-fg">
                <span className="mr-2 font-mono text-sm font-medium text-subtle">{p.key}</span>
                {p.name}
              </p>
              <p className="mt-1 flex gap-1.5">
                <Badge tone="amber">Archived</Badge>
                <Badge tone="blue">{p.myRole}</Badge>
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="primary"
                aria-label={`Restore ${p.key}`}
                loading={restore.isPending}
                data-testid={`restore-${p.key}`}
                onClick={() => restore.mutate(p.id, { onSuccess: () => toast.success(`${p.name} restored`) })}
              >
                Restore
              </Button>
              {p.myRole === 'owner' && (
                <Button
                  variant="danger-ghost"
                  aria-label={`Delete ${p.key} permanently`}
                  data-testid={`delete-${p.key}`}
                  onClick={() => setDeleting(p)}
                >
                  Delete permanently
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {deleting && (
        <DeleteProjectDialog
          project={deleting}
          open
          onOpenChange={(o) => {
            if (!o) setDeleting(null);
          }}
        />
      )}
    </section>
  );
}

const WORKFLOW_BLURB: Record<string, { title: string; text: string; icon: typeof Code2 }> = {
  code: {
    title: 'Code',
    text: 'Build features with agents. Spec to Finalize, uses repositories.',
    icon: Code2,
  },
  research: {
    title: 'Research',
    text: 'Answer questions with cited sources. Results go to your vault.',
    icon: FlaskConical,
  },
  feed: { title: 'Feed', text: 'Scheduled scans and digests you rate.', icon: Rss },
};

function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useCreateProject();
  const toast = useToast();
  const workflows = useWorkflows();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [workflowKey, setWorkflowKey] = useState('code');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const selected = workflows.data?.find((w) => w.definition.key === workflowKey)?.definition;
  const noRepo = selected ? !workflowUsesRepos(selected) : false;
  const keys = [...new Set(workflows.data?.map((w) => w.definition.key) ?? ['code'])];

  const onName = (v: string) => {
    setName(v);
    if (!keyTouched)
      setKey(
        v
          .replace(/[^A-Za-z0-9]/g, '')
          .slice(0, 4)
          .toUpperCase(),
      );
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = CreateProjectRequestSchema.safeParse({ key: key.trim(), name: name.trim(), workflowKey });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) {
        const k = String(i.path[0]);
        errs[k] =
          k === 'key' ? 'Key is 2-10 characters: A-Z and 0-9, starting with a letter' : 'Name is required';
      }
      setErrors(errs);
      return;
    }
    setErrors({});
    create.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(`Project ${parsed.data.name} created`);
        setKey('');
        setName('');
        setKeyTouched(false);
        onOpenChange(false);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New project"
      description="A project owns a board and agents. Code projects also own repositories."
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label="New project">
        <TextInput label="Name" value={name} onChange={(e) => onName(e.target.value)} error={errors.name} />
        <TextInput
          label="Key"
          value={key}
          onChange={(e) => {
            setKeyTouched(true);
            setKey(e.target.value.toUpperCase());
          }}
          error={errors.key}
          hint="Used in card refs, for example TOY-1"
          maxLength={10}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium text-fg">Workflow</legend>
          {keys.map((k) => {
            const b = WORKFLOW_BLURB[k];
            const Icon = b?.icon ?? FolderKanban;
            return (
              <label
                key={k}
                className={cx(
                  'flex cursor-pointer items-start gap-3 rounded-card border p-3 transition-colors',
                  workflowKey === k ? 'border-brand bg-brand-soft' : 'border-control hover:bg-sunken',
                )}
              >
                <input
                  type="radio"
                  name="workflow"
                  value={k}
                  checked={workflowKey === k}
                  onChange={() => setWorkflowKey(k)}
                  className="mt-1 size-4"
                />
                <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-medium text-fg">{b?.title ?? k}</span>
                  <span className="block text-sm text-muted">{b?.text ?? `Custom workflow ${k}.`}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <p className="-mt-2 text-xs text-subtle" data-testid="workflow-hint">
          {noRepo
            ? "No repository needed; results go to the project's vault folder."
            : 'Add repositories in project settings.'}
        </p>
        <ErrorBox error={create.error} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end [&>button]:max-sm:w-full">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create project
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
