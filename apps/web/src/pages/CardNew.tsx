import type { CompletionAction } from '@aom/shared';
import { FolderKanban } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useWorkflows } from '../api/queries/agents.ts';
import { uploadAll } from '../api/queries/attachments.ts';
import { useMe } from '../api/queries/auth.ts';
import { missingFromError, useCreateCard } from '../api/queries/cards.ts';
import { useProjectWorkflows } from '../api/queries/project-workflows.ts';
import { useProject, useProjects } from '../api/queries/projects.ts';
import { CardFormFields } from '../components/CardFormFields.tsx';
import { NewCardFiles } from '../components/NewCardFiles.tsx';
import {
  Button,
  ButtonLink,
  Callout,
  EmptyState,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
  Select,
  useToast,
} from '../components/ui.tsx';
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
  const enabledWorkflows = useProjectWorkflows(project?.id);
  const mockUi = useMe().data?.features?.mockUi ?? false;
  const workflow = useMemo(
    () =>
      workflows.data
        ?.filter((w) => w.definition.key === project?.workflowKey)
        .sort((a, b) => b.definition.version - a.definition.version)[0]?.definition,
    [workflows.data, project?.workflowKey],
  );

  if (projects.isPending || workflows.isPending)
    return (
      <div className="mx-auto max-w-2xl">
        <PageSkeleton label="Loading the form" />
      </div>
    );
  if (!projects.data?.length) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="New card" />
        <EmptyState
          icon={FolderKanban}
          title="Create a project first"
          description="Cards live on a project's board. Create a project, then come back."
          action={
            <ButtonLink to="/projects" variant="primary">
              Go to projects
            </ButtonLink>
          }
        />
      </div>
    );
  }
  if (!project || !workflow) return <ErrorBox error={new Error('Project or workflow not found')} />;
  // A research card may be created in any project: its own workflow runs it (restructure.md section 8.1).
  const research = workflow.cardTypes.includes('research' as never)
    ? undefined
    : workflows.data
        ?.filter((w) => w.definition.key === 'research')
        .sort((a, b) => b.definition.version - a.definition.version)[0]?.definition;

  // Other workflows the project enabled (#10): a variant is run with its base's fields and its own card types.
  const enabledExtra: Workflow[] = [];
  const defaults: Record<string, string> = {};
  for (const e of enabledWorkflows.data?.enabled ?? []) {
    for (const t of e.defaultCardTypes) defaults[t] = e.workflowKey;
    if (e.isPrimary || e.workflowKey === workflow.key) continue;
    const def = workflows.data
      ?.filter((w) => w.definition.key === (e.variantOf?.key ?? e.workflowKey))
      .sort((a, b) => b.definition.version - a.definition.version)[0]?.definition;
    if (def) enabledExtra.push({ ...def, key: e.workflowKey, name: e.name, cardTypes: e.cardTypes });
  }
  const extras = [
    ...enabledExtra,
    ...(research && !enabledExtra.some((w) => w.key === research.key) ? [research] : []),
  ];

  return (
    <CardNewForm
      key={project.id}
      projectId={project.id}
      projectKey={project.key}
      projectKeys={projects.data.map((p) => p.key)}
      onProject={setChosen}
      workflow={workflow}
      extraWorkflows={extras}
      defaultWorkflowFor={defaults}
      repos={(detail.data?.repos ?? []).filter((r) => !r.removedAt)}
      mockUi={mockUi}
      designDefault={detail.data?.project.designStep ?? false}
      projectDefault={detail.data?.project.defaultCompletion}
    />
  );
}

type Workflow = NonNullable<ReturnType<typeof useWorkflows>['data']>[number]['definition'];

export function CardNewForm({
  projectId,
  projectKey,
  projectKeys,
  onProject,
  workflow: projectWorkflow,
  extraWorkflows = [],
  defaultWorkflowFor = {},
  repos,
  mockUi = false,
  designDefault = false,
  projectDefault,
}: {
  projectId: string;
  projectKey: string;
  projectKeys: string[];
  onProject: (key: string) => void;
  workflow: Workflow;
  /** Workflows that run card types the project's own does not (research), offered in the type select. */
  extraWorkflows?: Workflow[];
  /** Per card type, the key of the workflow that is the project's default for it (project settings, Workflows). */
  defaultWorkflowFor?: Record<string, string>;
  repos: Array<{ id: string; name: string }>;
  /** Show the mock-runtime fields (server `AOM_MOCK_UI`); off for real users. */
  mockUi?: boolean;
  /** The project's "Investigate & design before build" setting. */
  designDefault?: boolean;
  /** How the project lands finished work (the default a new card follows). */
  projectDefault?: CompletionAction | undefined;
}) {
  const nav = useNavigate();
  const create = useCreateCard();
  const toast = useToast();
  const [v, setV] = useState<CardFormValues>(() => emptyForm(projectWorkflow.cardTypes[0] ?? ''));
  const [picked, setPicked] = useState<{ type: string; key: string } | null>(null);
  // The workflow of the chosen type decides the fields (a research card in a code project asks for the question).
  // When the project enabled more than one workflow for the type, the default (or the user's pick) decides.
  const choices = [projectWorkflow, ...extraWorkflows].filter((w) =>
    w.cardTypes.includes(v.cardType as never),
  );
  const wanted = picked?.type === v.cardType ? picked.key : defaultWorkflowFor[v.cardType];
  const workflow = choices.find((w) => w.key === wanted) ?? choices[0] ?? projectWorkflow;
  const chooseWorkflow = choices.length > 1;
  const cardTypes = [
    ...new Set([...projectWorkflow.cardTypes, ...extraWorkflows.flatMap((w) => w.cardTypes)]),
  ];
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState<{ id: string; ref: string; missing: string[] } | null>(null);
  // Files picked on the form: attached right after the card is created.
  const [files, setFiles] = useState<File[]>([]);
  const submit = (specify: boolean) => {
    const r = buildCardRequest(workflow, v, specify, mockUi, designDefault);
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
      { projectId, ...body, ...(chooseWorkflow ? { workflowKey: workflow.key } : {}), specify },
      {
        onSuccess: async (res) => {
          if (files.length > 0) {
            const { failed } = await uploadAll(res.card.id, files);
            setFiles([]);
            if (failed.length)
              toast.error(
                `${res.card.ref} was saved, but ${failed.length} file${failed.length === 1 ? '' : 's'} could not be attached (${failed.map((f) => `${f.name}: ${f.message}`).join('; ')}). Add them on the card.`,
              );
          }
          if (specify && res.missing?.length) {
            const errs: Record<string, string> = {};
            for (const m of res.missing)
              errs[m] = `${fieldLabel(workflow, m)} is required to specify this card`;
            setErrors(errs);
            setNote({ id: res.card.id, ref: res.card.ref, missing: res.missing });
            return;
          }
          toast.success(specify ? `${res.card.ref} specified` : `Saved as draft ${res.card.ref}`);
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
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="New card"
        back={{ to: `/p/${projectKey}/board`, label: 'Back to the board' }}
        sub={`${projectKey} · ${projectWorkflow.name} workflow${workflow !== projectWorkflow ? `, this card runs on ${workflow.name}` : ''}`}
      />
      <form onSubmit={onSubmit} noValidate aria-label="New card" className="flex flex-col gap-4">
        <Panel>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
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
                {cardTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
            {chooseWorkflow && (
              <Select
                label="Workflow"
                data-testid="card-workflow"
                hint="This project runs more than one workflow for this card type."
                value={workflow.key}
                onChange={(e) => setPicked({ type: v.cardType, key: e.target.value })}
              >
                {choices.map((w) => (
                  <option key={w.key} value={w.key}>
                    {w.name}
                  </option>
                ))}
              </Select>
            )}
            <CardFormFields
              workflow={workflow}
              values={v}
              onChange={setV}
              errors={errors}
              repos={repos}
              mockUi={mockUi}
              designDefault={designDefault}
              projectDefault={projectDefault}
            />
          </div>
        </Panel>
        <NewCardFiles files={files} onChange={setFiles} />
        {errors._form && <ErrorBox error={new Error(errors._form)} />}
        {Object.keys(errors).some((k) => k !== '_form') && (
          <Callout tone="danger" role="alert">
            Fix the highlighted fields.
          </Callout>
        )}
        {note && (
          <Callout tone="warning" role="status">
            Saved as draft{' '}
            <Link className="font-medium underline" to={`/cards/${note.ref}`}>
              {note.ref}
            </Link>
            ; still missing {note.missing.map((m) => fieldLabel(workflow, m)).join(', ')}.
          </Callout>
        )}
        {create.error && !errors._form && !missingFromError(create.error).length && (
          <ErrorBox error={create.error} />
        )}
        <div className="sticky bottom-0 z-10 -mx-4 border-t border-line bg-canvas/90 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:mx-0 sm:rounded-card sm:border sm:px-4">
          <p id="new-card-help" className="mb-2 text-xs text-subtle">
            Specify sends the card to the Spec stage and checks every required field. Save draft keeps it
            private until you are ready.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end [&>*]:max-sm:w-full">
            <ButtonLink to={`/p/${projectKey}/board`} variant="ghost">
              Cancel
            </ButtonLink>
            <Button
              aria-describedby="new-card-help"
              disabled={create.isPending}
              onClick={() => submit(false)}
            >
              Save draft
            </Button>
            <Button
              type="submit"
              variant="primary"
              aria-describedby="new-card-help"
              loading={create.isPending}
            >
              Specify
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
