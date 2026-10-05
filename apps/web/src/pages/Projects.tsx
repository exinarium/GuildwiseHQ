import type { ProjectDto } from '@aom/shared';
import { CreateProjectRequestSchema, workflowUsesRepos } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { useWorkflows } from '../api/queries/agents.ts';
import {
  useArchivedProjects,
  useCreateProject,
  useProjects,
  useRestoreProject,
} from '../api/queries/projects.ts';
import { DeleteProjectDialog } from '../components/DeleteProjectDialog.tsx';
import { ProjectInvitations } from '../components/ProjectInvitations.tsx';
import {
  Badge,
  Button,
  Dialog,
  ErrorBox,
  PageHeader,
  Panel,
  Select,
  Spinner,
  TextInput,
} from '../components/ui.tsx';
import { departmentsOf, inDepartment } from '../lib/designer.ts';

export function Projects() {
  const projects = useProjects();
  const archived = useArchivedProjects();
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState(false);
  const [department, setDepartment] = useState('');
  const departments = departmentsOf(projects.data ?? []);
  const shown = inDepartment(projects.data ?? [], department);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Projects"
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            New project
          </Button>
        }
      />
      <ProjectInvitations />
      {departments.length > 0 && (
        <div className="mb-3 max-w-xs">
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
      <div className="mb-3 flex gap-1" role="tablist" aria-label="Project filter">
        <Button
          role="tab"
          aria-selected={!showArchived}
          variant={showArchived ? 'ghost' : 'secondary'}
          data-testid="filter-active"
          onClick={() => setShowArchived(false)}
        >
          Active
        </Button>
        <Button
          role="tab"
          aria-selected={showArchived}
          variant={showArchived ? 'secondary' : 'ghost'}
          data-testid="filter-archived"
          onClick={() => setShowArchived(true)}
        >
          Archived{archived.data && archived.data.length > 0 ? ` (${archived.data.length})` : ''}
        </Button>
      </div>
      {showArchived && <ArchivedProjects />}
      {!showArchived && projects.isPending && <Spinner />}
      {!showArchived && projects.isError && <ErrorBox error={projects.error} />}
      {!showArchived && projects.data?.length === 0 && (
        <Panel>
          <p className="text-sm text-zinc-500">No projects yet. Create one to start a board.</p>
        </Panel>
      )}
      <ul className="flex flex-col gap-2" hidden={showArchived}>
        {shown.map((p) => (
          <li key={p.id}>
            <Panel className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">
                  <span className="mr-2 font-mono text-xs text-zinc-500">{p.key}</span>
                  {p.name}
                </p>
                <p className="mt-0.5 flex gap-1.5 text-xs text-zinc-500">
                  <Badge>{p.workflowKey}</Badge>
                  {p.department && <Badge tone="violet">{p.department}</Badge>}
                  <Badge>{p.domain}</Badge>
                  <Badge tone="blue">{p.myRole}</Badge>
                </p>
              </div>
              <div className="flex gap-2 text-sm">
                <Link className="rounded-md px-2 py-1 underline" to={`/p/${p.key}/board`}>
                  Board
                </Link>
                <Link
                  className="rounded-md px-2 py-1 underline"
                  aria-label={`Settings for ${p.key}`}
                  to={`/projects/${p.id}/settings`}
                >
                  Settings
                </Link>
              </div>
            </Panel>
          </li>
        ))}
      </ul>
      <NewProjectDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

/** Archived projects: Restore for any member, "Delete permanently" (type the key) for the project owner. */
function ArchivedProjects() {
  const archived = useArchivedProjects();
  const restore = useRestoreProject();
  const [deleting, setDeleting] = useState<ProjectDto | null>(null);
  return (
    <section aria-label="Archived projects" data-testid="archived-projects">
      {archived.isPending && <Spinner />}
      {archived.isError && <ErrorBox error={archived.error} />}
      {archived.data?.length === 0 && (
        <Panel>
          <p className="text-sm text-zinc-500" data-testid="archived-empty">
            No archived projects.
          </p>
        </Panel>
      )}
      <ErrorBox error={restore.error} />
      <ul className="flex flex-col gap-2">
        {archived.data?.map((p) => (
          <li key={p.id} data-testid={`archived-${p.key}`}>
            <Panel className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">
                  <span className="mr-2 font-mono text-xs text-zinc-500">{p.key}</span>
                  {p.name}
                </p>
                <p className="mt-0.5 flex gap-1.5 text-xs text-zinc-500">
                  <Badge tone="amber">Archived</Badge>
                  <Badge tone="blue">{p.myRole}</Badge>
                </p>
              </div>
              <div className="flex gap-2 text-sm">
                <Button
                  variant="primary"
                  aria-label={`Restore ${p.key}`}
                  disabled={restore.isPending}
                  data-testid={`restore-${p.key}`}
                  onClick={() => restore.mutate(p.id)}
                >
                  Restore
                </Button>
                {p.myRole === 'owner' && (
                  <Button
                    variant="danger"
                    aria-label={`Delete ${p.key} permanently`}
                    data-testid={`delete-${p.key}`}
                    onClick={() => setDeleting(p)}
                  >
                    Delete permanently
                  </Button>
                )}
              </div>
            </Panel>
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

function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useCreateProject();
  const workflows = useWorkflows();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [workflowKey, setWorkflowKey] = useState('code');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const selected = workflows.data?.find((w) => w.definition.key === workflowKey)?.definition;
  const noRepo = selected ? !workflowUsesRepos(selected) : false;
  const keys = [...new Set(workflows.data?.map((w) => w.definition.key) ?? ['code'])];

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
        setKey('');
        setName('');
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
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <TextInput
          label="Key"
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          error={errors.key}
          hint="Used in card refs, for example TOY-1"
          maxLength={10}
        />
        <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
        <Select label="Workflow" value={workflowKey} onChange={(e) => setWorkflowKey(e.target.value)}>
          {keys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <p className="-mt-2 text-xs text-zinc-500" data-testid="workflow-hint">
          {noRepo
            ? "No repository needed; results go to the project's vault folder."
            : 'Add repositories in project settings.'}
        </p>
        <ErrorBox error={create.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Create project
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
