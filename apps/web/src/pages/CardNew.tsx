import { CompletionAction, ResearchDepth } from '@aom/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useWorkflows } from '../api/queries/agents.ts';
import { missingFromError, useCreateCard } from '../api/queries/cards.ts';
import { useProject, useProjects } from '../api/queries/projects.ts';
import { Button, ErrorBox, PageHeader, Select, Spinner, TextArea, TextInput } from '../components/ui.tsx';
import {
  buildCardRequest,
  type CardFormValues,
  emptyForm,
  fieldLabel,
  formFieldList,
} from '../lib/cardForm.ts';
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
}: {
  projectId: string;
  projectKey: string;
  projectKeys: string[];
  onProject: (key: string) => void;
  workflow: Workflow;
  repos: Array<{ id: string; name: string }>;
}) {
  const nav = useNavigate();
  const create = useCreateCard();
  const [v, setV] = useState<CardFormValues>(() => emptyForm(workflow.cardTypes[0] ?? ''));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState<{ id: string; ref: string; missing: string[] } | null>(null);
  const list = formFieldList(workflow);
  // Repository and completion action belong to code work; research and feed cards live in the vault.
  const codeCard = workflow.fieldSet !== 'research' && workflow.fieldSet !== 'feed';
  const setField = (k: string, val: string) => setV((s) => ({ ...s, fields: { ...s.fields, [k]: val } }));

  const submit = (specify: boolean) => {
    const r = buildCardRequest(workflow, v, specify);
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
        <TextInput
          label="Title"
          value={v.title}
          onChange={(e) => setV({ ...v, title: e.target.value })}
          error={errors.title}
          maxLength={300}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {codeCard && (
            <>
              <Select
                label="Repository"
                value={v.repoId}
                onChange={(e) => setV({ ...v, repoId: e.target.value })}
                error={errors.repoId}
              >
                <option value="">None</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
              <Select
                label="Completion action"
                value={v.completionAction}
                onChange={(e) => setV({ ...v, completionAction: e.target.value })}
                error={errors.completionAction}
              >
                <option value="">None</option>
                {CompletionAction.options.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </>
          )}
          <TextInput
            label="Priority (1-9)"
            inputMode="numeric"
            value={v.priority}
            onChange={(e) => setV({ ...v, priority: e.target.value })}
            error={errors.priority}
          />
          {codeCard && (
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                checked={v.docsNeeded}
                onChange={(e) => setV({ ...v, docsNeeded: e.target.checked })}
              />
              Docs needed
            </label>
          )}
        </div>
        {list.map(([k, meta]) => {
          const common = {
            label: meta.label,
            value: v.fields[k] ?? '',
            error: errors[k],
          };
          if (meta.kind === 'text') {
            return <TextInput key={k} {...common} onChange={(e) => setField(k, e.target.value)} />;
          }
          if (meta.kind === 'number') {
            return (
              <TextInput
                key={k}
                {...common}
                inputMode="numeric"
                onChange={(e) => setField(k, e.target.value)}
              />
            );
          }
          if (meta.kind === 'enum' && k === 'depth') {
            return (
              <Select key={k} {...common} onChange={(e) => setField(k, e.target.value)}>
                <option value="">Choose...</option>
                {ResearchDepth.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            );
          }
          const hint =
            meta.kind === 'list' || meta.kind === 'url-list'
              ? 'One item per line'
              : meta.kind === 'json'
                ? 'JSON, optional'
                : undefined;
          return (
            <TextArea
              key={k}
              {...common}
              {...(hint ? { hint } : {})}
              rows={meta.kind === 'markdown' || meta.kind === 'list' ? 4 : 3}
              className={meta.kind === 'json' ? 'font-mono' : undefined}
              onChange={(e) => setField(k, e.target.value)}
            />
          );
        })}
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
