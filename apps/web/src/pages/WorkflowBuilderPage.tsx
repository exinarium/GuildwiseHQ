import {
  BUILTIN_WORKFLOWS,
  copyBuiltinAsCustom,
  type DefinitionIssue,
  instantiateTemplate,
  type OrgCatalogueResponse,
  type WorkflowDefinitionInput,
  type WorkflowDraftInput,
  type WorkflowVersionDto,
} from '@aom/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useAgents } from '../api/queries/agents.ts';
import {
  useOrgCatalogue,
  useSaveWorkflowDraft,
  useSubmitDraft,
  useSubworkflowTargets,
} from '../api/queries/org.ts';
import { BuilderChat } from '../components/builder/BuilderChat.tsx';
import { SubworkflowEditor } from '../components/builder/SubworkflowEditor.tsx';
import { TemplateGallery } from '../components/builder/TemplateGallery.tsx';
import { VersionCompare } from '../components/builder/VersionCompare.tsx';
import { WorkflowBuilder } from '../components/builder/WorkflowBuilder.tsx';
import { WorkflowEditor } from '../components/org/WorkflowEditor.tsx';
import { LargerScreenNote } from '../components/ui/LargerScreenNote.tsx';
import { Badge, Button, Callout, Disclosure, ErrorBox, ListSkeleton, PageHeader } from '../components/ui.tsx';
import {
  type BuilderModel,
  type BuilderValidation,
  builderCaveats,
  builderRoles,
  describeDraft,
  freezeModel,
  fromDefinition,
  frozenFor,
  syncKey,
  takenWorkflowKeys,
  toDefinition,
} from '../lib/builder.ts';
import { buildSubworkflowLookup } from '../lib/subworkflowStep.ts';

const STATUS_TONE = {
  active: 'green',
  pending_approval: 'amber',
  draft: 'blue',
  superseded: 'neutral',
  rejected: 'red',
} as const;
const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  pending_approval: 'Waiting for approval',
  draft: 'Draft',
  superseded: 'Replaced by a newer version',
  rejected: 'Rejected',
  new: 'Not saved yet',
};

function apiIssues(e: unknown): DefinitionIssue[] | undefined {
  return e instanceof ApiError
    ? (e.details as { issues?: DefinitionIssue[] } | undefined)?.issues
    : undefined;
}

interface Found {
  workflowKey: string;
  builtIn: boolean;
  version: WorkflowVersionDto;
}

function findVersion(cat: OrgCatalogueResponse, id: string): Found | undefined {
  for (const w of cat.workflows) {
    const version = w.versions.find((v) => v.id === id);
    if (version) return { workflowKey: w.key, builtIn: w.builtIn, version };
  }
  return undefined;
}

/**
 * The workflow builder (docs/design/workflow-builder.md section 7): `/org/workflows/new` shows the template gallery,
 * `/org/workflows/new?template=|copy=|from=` starts a draft, `/org/workflows/:draftId` opens a saved version.
 */
export function WorkflowBuilderPage() {
  const { draftId = 'new' } = useParams();
  const [params] = useSearchParams();
  const projectId = params.get('project') || undefined;
  const cat = useOrgCatalogue(projectId);
  const navigate = useNavigate();
  const search = params.toString();
  const withProject = (extra: Record<string, string> = {}) => {
    const q = new URLSearchParams(extra);
    if (projectId) q.set('project', projectId);
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  if (cat.isPending) return <ListSkeleton label="Loading the workflow" rows={4} />;
  if (cat.isError) return <ErrorBox error={cat.error} onRetry={() => cat.refetch()} />;
  const data = cat.data;
  const template = params.get('template');
  const copy = params.get('copy');
  const from = params.get('from');

  if (draftId === 'new' && !template && !copy && !from) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader
          title="New workflow"
          sub="Start from a template, or copy a built-in workflow."
          back={{ to: '/org?tab=workflows', label: 'Back to workflows' }}
        />
        {!data.canEdit ? (
          <Callout tone="info" role="note">
            Only the organization's Owner and Admins build workflows.
          </Callout>
        ) : (
          <TemplateGallery
            onTemplate={(id) => navigate(`/org/workflows/new${withProject({ template: id })}`)}
            onCopy={(key) => navigate(`/org/workflows/new${withProject({ copy: key })}`)}
          />
        )}
      </div>
    );
  }

  return (
    <BuilderSession
      key={`${draftId}?${search}`}
      cat={data}
      draftId={draftId}
      template={template}
      copy={copy}
      from={from}
      projectId={projectId}
    />
  );
}

function seedModel(
  cat: OrgCatalogueResponse,
  draftId: string,
  template: string | null,
  copy: string | null,
  from: string | null,
): { model: BuilderModel; found?: Found; notices: string[]; missing?: boolean } {
  const taken = takenWorkflowKeys(cat);
  if (draftId !== 'new') {
    const found = findVersion(cat, draftId);
    if (!found) return { model: fromDefinition(blankDef()), notices: [], missing: true };
    return { model: fromDefinition(found.version.definition), found, notices: [] };
  }
  if (from) {
    const found = findVersion(cat, from);
    if (!found) return { model: fromDefinition(blankDef()), notices: [], missing: true };
    return { model: fromDefinition(found.version.definition), found, notices: [] };
  }
  if (copy) {
    const builtin = BUILTIN_WORKFLOWS.find((w) => w.key === copy);
    if (!builtin) return { model: fromDefinition(blankDef()), notices: [], missing: true };
    const r = copyBuiltinAsCustom(builtin, { key: 'copy' });
    return { model: syncKey(fromDefinition(r.definition, { freeze: false }), taken), notices: r.notices };
  }
  const def = template ? instantiateTemplate(template, { key: 'new' }) : undefined;
  if (!def) return { model: fromDefinition(blankDef()), notices: [], missing: true };
  const model = fromDefinition(def, { freeze: false });
  return { model: syncKey(template === 'blank' ? { ...model, name: '' } : model, taken), notices: [] };
}

function blankDef(): WorkflowDefinitionInput {
  return (
    (instantiateTemplate('blank', { key: 'new' }) as WorkflowDefinitionInput) ?? {
      key: 'new',
      version: 1,
      name: '',
      builtIn: false,
      fieldSet: 'custom',
      customFields: [],
      cardTypes: ['support'],
      initialStage: 'a',
      stages: [],
    }
  );
}

function BuilderSession({
  cat,
  draftId,
  template,
  copy,
  from,
  projectId,
}: {
  cat: OrgCatalogueResponse;
  draftId: string;
  template: string | null;
  copy: string | null;
  from: string | null;
  projectId?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  // The seed is read once: later catalogue refreshes must not replace what the owner is editing.
  const [seed] = useState(() => seedModel(cat, draftId, template, copy, from));
  const [model, setModel] = useState<BuilderModel>(seed.model);
  const [notices, setNotices] = useState<string[]>(seed.notices);
  const [dirty, setDirty] = useState(draftId === 'new');
  const landed = location.state as { issues?: DefinitionIssue[]; saved?: boolean } | null;
  const [serverIssues, setServerIssues] = useState<DefinitionIssue[] | undefined>(landed?.issues);
  const [savedNote, setSavedNote] = useState(landed?.saved ?? false);
  const [validation, setValidation] = useState<BuilderValidation | null>(null);
  const [sent, setSent] = useState<{ deskItemId: string } | null>(null);
  // The version being edited: a stored draft, or none (the next save creates one).
  const found = draftId !== 'new' ? seed.found : undefined;
  const [savedId, setSavedId] = useState<string | undefined>(
    found?.version.status === 'draft' ? found.version.id : undefined,
  );
  const [status, setStatus] = useState<string>(found ? found.version.status : 'new');

  const save = useSaveWorkflowDraft();
  const submit = useSubmitDraft();
  const subTargets = useSubworkflowTargets(projectId);
  const subLookup = useMemo(() => buildSubworkflowLookup(cat, subTargets.data), [cat, subTargets.data]);
  const agents = useAgents();
  const hiredRoleKeys = useMemo(
    () =>
      agents.data
        ? new Set(agents.data.filter((a) => a.status === 'active').map((a) => a.roleKey))
        : undefined,
    [agents.data],
  );
  const roles = useMemo(() => builderRoles(cat), [cat]);
  const departments = useMemo(() => cat.departments.map((d) => d.name), [cat]);
  const takenKeys = useMemo(() => takenWorkflowKeys(cat), [cat]);
  const frozen = useMemo(() => frozenFor(cat, model.key), [cat, model.key]);
  const versions = useMemo(
    () => cat.workflows.find((w) => w.key === model.key)?.versions ?? [],
    [cat, model.key],
  );
  const readOnly = !cat.canEdit || (status !== 'draft' && status !== 'new') || (found?.builtIn ?? false);
  const caveats = useMemo(() => builderCaveats(model), [model]);
  const showWorktree = model.steps.some((s) => s.worktree !== 'none');

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const edit = useCallback((m: BuilderModel) => {
    setModel(m);
    setDirty(true);
    setServerIssues(undefined);
    setSavedNote(false);
  }, []);
  const q = projectId ? `?project=${projectId}` : '';

  const run = async (andSubmit: boolean) => {
    if (readOnly) return;
    const input = toDefinition(model, { frozen }) as unknown as WorkflowDraftInput;
    try {
      const r = await save.mutateAsync({ id: savedId, input, projectId });
      setServerIssues(r.issues.length > 0 ? r.issues : undefined);
      const hasErrors = r.issues.some((i) => i.severity === 'error');
      let finalStatus = r.status as string;
      if (andSubmit && !hasErrors) {
        await submit.mutateAsync({ kind: 'workflows', id: r.id, projectId });
        finalStatus = 'pending_approval';
        setSent({ deskItemId: '' });
      }
      setSavedId(r.id);
      setStatus(finalStatus);
      setDirty(false);
      setSavedNote(true);
      setModel((m) => freezeModel(m, frozen));
      if (draftId === 'new') {
        await qc.invalidateQueries({ queryKey: ['org', 'catalogue'] });
        navigate(`/org/workflows/${r.id}${q}`, { replace: true, state: { saved: true, issues: r.issues } });
      }
    } catch (e) {
      const issues = apiIssues(e);
      if (issues) setServerIssues(issues);
    }
  };

  if (seed.missing)
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader
          title="Workflow not found"
          back={{ to: '/org?tab=workflows', label: 'Back to workflows' }}
        />
        <Callout tone="warning" role="note">
          This workflow draft no longer exists, or it belongs to another organization. Go back to the list and
          start again.
        </Callout>
      </div>
    );

  const errors = validation?.errors ?? 0;
  const busy = save.isPending || submit.isPending;
  const base = found && found.version.status !== 'draft' ? found.version : undefined;
  const title = model.name.trim() || 'New workflow';

  return (
    <div className="mx-auto max-w-7xl" data-testid="workflow-builder-page">
      <PageHeader
        title={title}
        back={{
          to: `/org?tab=workflows${projectId ? `&project=${projectId}` : ''}`,
          label: 'Back to workflows',
        }}
        eyebrow={
          <p className="mb-1 flex flex-wrap items-center gap-2 text-sm">
            <Badge
              tone={STATUS_TONE[status as keyof typeof STATUS_TONE] ?? 'neutral'}
              data-testid="builder-status"
            >
              {STATUS_LABEL[status] ?? status}
            </Badge>
            {found && <span className="font-mono text-xs text-subtle">v{found.version.version}</span>}
            {dirty && !readOnly && (
              <span className="text-xs text-warning" data-testid="unsaved">
                Unsaved changes
              </span>
            )}
            {savedNote && !dirty && (
              <span className="text-xs text-subtle" role="status">
                Saved
              </span>
            )}
          </p>
        }
        actions={
          readOnly ? (
            base && cat.canEdit && !found?.builtIn ? (
              <Button
                variant="primary"
                onClick={() =>
                  navigate(`/org/workflows/new?from=${base.id}${projectId ? `&project=${projectId}` : ''}`)
                }
              >
                Edit as new version
              </Button>
            ) : null
          ) : (
            <>
              <Button disabled={busy || (!dirty && !!savedId)} onClick={() => run(false)}>
                Save draft
              </Button>
              <Button
                variant="primary"
                disabled={busy || errors > 0}
                aria-describedby={errors > 0 ? 'submit-hint' : undefined}
                onClick={() => run(true)}
              >
                Save and send for approval
              </Button>
            </>
          )
        }
      />
      {!readOnly && errors > 0 && (
        <p id="submit-hint" className="-mt-3 mb-3 text-right text-xs text-subtle">
          Fix the {errors === 1 ? 'problem' : 'problems'} listed below to send this for approval.
        </p>
      )}
      <div className="flex flex-col gap-4">
        {!readOnly && <LargerScreenNote />}
        {!cat.canEdit && (
          <Callout tone="info" role="note" data-testid="read-only-note">
            Only the organization's Owner and Admins change workflows. You can look at this one.
          </Callout>
        )}
        {status === 'pending_approval' && (
          <Callout
            tone="info"
            role="status"
            data-testid="pending-note"
            actions={
              <Link to="/desk" className="underline">
                Open the desk
              </Link>
            }
          >
            {sent ? 'Sent.' : 'This version is waiting for approval.'} Owners and Admins approve it on the
            desk; until then cards keep using the current version.
          </Callout>
        )}
        {status === 'active' && cat.canEdit && (
          <Callout tone="info" role="note">
            This version is live. To change it, use Edit as new version: running cards finish on the version
            they started on.
          </Callout>
        )}
        {notices.length > 0 && (
          <Callout
            tone="warning"
            role="note"
            title="This copy lost some of the built-in behaviour"
            data-testid="copy-notices"
            actions={
              <Button size="sm" onClick={() => setNotices([])}>
                Got it
              </Button>
            }
          >
            <ul className="list-disc pl-4">
              {notices.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </Callout>
        )}
        <ErrorBox error={save.error ?? submit.error} />

        <WorkflowBuilder
          model={model}
          onChange={edit}
          roles={roles}
          departments={departments}
          takenKeys={takenKeys}
          hiredRoleKeys={hiredRoleKeys}
          frozen={frozen}
          serverIssues={serverIssues}
          readOnly={readOnly}
          showWorktree={showWorktree}
          autoStart
          onValidation={setValidation}
          subworkflowLookup={subLookup}
          renderSubworkflowEditor={(ctx) => (
            <SubworkflowEditor
              ctx={ctx}
              targets={subTargets.data}
              loading={subTargets.isPending}
              failed={subTargets.isError}
              selfKey={model.key}
            />
          )}
          aside={<BuilderChat outline={() => describeDraft(model, savedId)} disabled={!cat.canEdit} />}
        />

        <VersionCompare
          versions={versions}
          draft={toDefinition(model, { frozen }) as unknown as WorkflowDefinitionInput}
        />

        <Disclosure
          summary="Advanced: table editor"
          defaultOpen={caveats.length > 0}
          data-testid="advanced-panel"
        >
          <p className="mb-2 text-xs text-subtle">
            The same workflow as a table, with the internal ids, the kind of every route and the events.
            Changes here show up in the steps above.
            {caveats.length > 0 &&
              ` This workflow has parts the step list only shows in part: ${caveats.join('; ')}.`}
          </p>
          <WorkflowEditor
            value={toDefinition(model, { frozen }) as unknown as WorkflowDraftInput}
            onChange={(v) => edit(fromDefinition(v as unknown as WorkflowDefinitionInput))}
            roles={roles}
            departments={departments}
            serverIssues={serverIssues}
            readOnly={readOnly}
          />
        </Disclosure>
      </div>
    </div>
  );
}
