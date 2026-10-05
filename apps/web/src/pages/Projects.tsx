import { CreateProjectRequestSchema, workflowUsesRepos } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { useWorkflows } from '../api/queries/agents.ts';
import { useCreateProject, useProjects } from '../api/queries/projects.ts';
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
      {projects.isPending && <Spinner />}
      {projects.isError && <ErrorBox error={projects.error} />}
      {projects.data?.length === 0 && (
        <Panel>
          <p className="text-sm text-zinc-500">No projects yet. Create one to start a board.</p>
        </Panel>
      )}
      <ul className="flex flex-col gap-2">
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
