import { type FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useWorkflows } from '../api/queries/agents.ts';
import { useMe } from '../api/queries/auth.ts';
import { missingFromError, useCreateCard } from '../api/queries/cards.ts';
import { useProject, useProjects } from '../api/queries/projects.ts';
import { CardFormFields } from '../components/CardFormFields.tsx';
import { Button, ErrorBox, PageHeader, Select, Spinner } from '../components/ui.tsx';
import { buildCardRequest, type CardFormValues, emptyForm, fieldLabel } from '../lib/cardForm.ts';
import { getLastProjectKey } from '../lib/lastProject.ts';

export function CardNew() {
  const [params] = useSearchParams();
  const projects = useProjects();
  const key = params.get('project') ?? getLastProjectKey();
  const [chosen, setChosen] = useState<string | null>(null);
  const project =
    projects.data?.find((p) => p.key === (chosen ?? key)) ?? (chosen ? undefined : projects.data?.[0]);
  // The workflow of a shared project is its owner's (custom ones included).
  const workflows = useWorkflows(project?.id);
  const detail = useProject(project?.id);
  const mockUi = useMe().data?.features?.mockUi ?? false;
  const workflow = useMemo(
    () =>
      workflows.data
        ?.filter((w) => w.definition.key === project?.workflowKey)
        .sort((a, b) => b.definition.version - a.definition.version)[0]?.definition,
    [workflows.data, project?.workflowKey],
  );

  if (projects.isPending || workflows.isPending) return <Spinner />;
  if (!projects.data?.length) {
    return (
      <div>
        <PageHeader title="New card" />
        <p className="text-sm text-zinc-500">
          Create a project first.{' '}
          <Link to="/projects" className="underline">
            Go to projects
          </Link>
        </p>
      </div>
    );
  }
  if (!project || !workflow) return <ErrorBox error={new Error('Project or workflow not found')} />;

  return (
    <CardNewForm
      key={project.id}
      projectId={project.id}
      projectKey={project.key}
      projectKeys={projects.data.map((p) => p.key)}
      onProject={setChosen}
      workflow={workflow}
      repos={(detail.data?.repos ?? []).filter((r) => !r.removedAt)}
      mockUi={mockUi}
    />
  );
}

type Workflow = NonNullable<ReturnType<typeof useWorkflows>['data']>[number]['definition'];

export function CardNewForm({
  projectId,
  projectKey,
  projectKeys,
  onProject,
  workflow,
  repos,
  mockUi = false,
}: {
  projectId: string;
  projectKey: string;
  projectKeys: string[];
  onProject: (key: string) => void;
  workflow: Workflow;
  repos: Array<{ id: string; name: string }>;
  /** Show the mock-runtime fields (server `AOM_MOCK_UI`); off for real users. */
  mockUi?: boolean;
}) {
  const nav = useNavigate();
  const create = useCreateCard();
  const [v, setV] = useState<CardFormValues>(() => emptyForm(workflow.cardTypes[0] ?? ''));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState<{ id: string; ref: string; missing: string[] } | null>(null);
  const submit = (specify: boolean) => {
    const r = buildCardRequest(workflow, v, specify, mockUi);
    setErrors(r.errors);
    setNote(null);
    if (Object.keys(r.errors).length) {
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('form[aria-label="New card"] [aria-invalid="true"]')?.focus(),
      );
      return;
    }
    const { errors: _e, ...body } = r;
    create.mutate(
      { projectId, ...body, specify },
      {
        onSuccess: (res) => {
          if (specify && res.missing?.length) {
            const errs: Record<string, string> = {};
            for (const m of res.missing)
              errs[m] = `${fieldLabel(workflow, m)} is required to specify this card`;
            setErrors(errs);
            setNote({ id: res.card.id, ref: res.card.ref, missing: res.missing });
            return;
          }
          nav(`/cards/${res.card.ref}`);
        },
        onError: (e) => {
          const missing = missingFromError(e);
          if (missing.length) {
            const errs: Record<string, string> = {};
            for (const m of missing) errs[m] = `${fieldLabel(workflow, m)} is required to specify this card`;
            setErrors(errs);
          } else if (e instanceof ApiError && e.status === 400 && e.details) {
            setErrors({ _form: e.message });
          }
        },
      },
    );
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(true);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="New card" sub={`${projectKey} · ${workflow.name} workflow`} />
      <form onSubmit={onSubmit} noValidate aria-label="New card" className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Project" value={projectKey} onChange={(e) => onProject(e.target.value)}>
            {projectKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          <Select
            label="Card type"
            value={v.cardType}
            onChange={(e) => setV({ ...v, cardType: e.target.value })}
            error={errors.cardType}
          >
            {workflow.cardTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        <CardFormFields
          workflow={workflow}
          values={v}
          onChange={setV}
          errors={errors}
          repos={repos}
          mockUi={mockUi}
        />
        {errors._form && <ErrorBox error={new Error(errors._form)} />}
        {Object.keys(errors).some((k) => k !== '_form') && (
          <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
            Fix the highlighted fields.
          </p>
        )}
        {note && (
          <p role="status" className="text-sm">
            Saved as draft{' '}
            <Link className="underline" to={`/cards/${note.ref}`}>
              {note.ref}
            </Link>
            ; still missing {note.missing.map((m) => fieldLabel(workflow, m)).join(', ')}.
          </p>
        )}
        {create.error && !errors._form && !missingFromError(create.error).length && (
          <ErrorBox error={create.error} />
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Specify
          </Button>
          <Button disabled={create.isPending} onClick={() => submit(false)}>
            Save draft
          </Button>
          <Link
            to={`/p/${projectKey}/board`}
            className="inline-flex min-h-8 items-center px-3 text-sm text-zinc-600 underline dark:text-zinc-400"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
