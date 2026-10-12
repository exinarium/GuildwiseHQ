import type { DefinitionIssue, ProjectWorkflowDto, WorkflowDefinition } from '@aom/shared';
import { useCallback, useMemo, useState } from 'react';
import { useAgents, useRoles } from '../api/queries/agents.ts';
import { useOrgCatalogue } from '../api/queries/org.ts';
import { useRebaseVariant, useSaveVariantDraft, useSubmitVariant } from '../api/queries/project-workflows.ts';
import {
  type EditorInsertion,
  findBaseDefinition,
  materialise,
  suggestVariant,
  type VariantCheck,
  variantRequest,
} from '../lib/workflowVariant.ts';
import { VariantBuilder } from './builder/VariantBuilder.tsx';
import { Button, Callout, Dialog, ErrorBox, TextInput, useToast } from './ui.tsx';

/**
 * "Customise" a workflow for one project (docs/design/architect-and-workflows.md 4.4, rebuilt on the workflow
 * builder in project-variant scope by docs/design/workflow-builder.md WP4). The base steps are locked; the author
 * inserts steps. The builder edits the variant's insertions, which stay the storage format: a draft is saved with
 * "Save draft" (the server answers with the validation issues), a draft without errors is sent to the owner's desk.
 * Running cards keep their version.
 */
export function WorkflowVariantEditor({
  projectId,
  projectKey,
  base,
  open,
  onOpenChange,
}: {
  projectId: string;
  projectKey: string;
  /** The workflow being customised, or the project's variant being edited (then its steps are the starting point). */
  base: ProjectWorkflowDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isVariant = !!base.variantOf;
  const baseRef = base.variantOf ?? { key: base.workflowKey, version: base.version };
  const draft = base.pendingVersion?.status === 'draft' ? base.pendingVersion : null;
  const waiting = base.pendingVersion?.status === 'pending_approval';
  const startSpec = draft?.variantSpec ?? base.variantSpec ?? null;
  const suggested = suggestVariant(base, projectKey);
  const [key, setKey] = useState(startSpec?.key ?? (isVariant ? base.workflowKey : suggested.key));
  const [name, setName] = useState(startSpec?.name ?? (isVariant ? base.name : suggested.name));
  const [insertions, setInsertions] = useState<EditorInsertion[]>(startSpec?.insertions ?? []);
  const [draftId, setDraftId] = useState<string | undefined>(draft?.id);
  const [serverIssues, setServerIssues] = useState<DefinitionIssue[] | undefined>();
  const [dirty, setDirty] = useState(false);
  const [check, setCheck] = useState<VariantCheck | null>(null);
  const catalogue = useOrgCatalogue(projectId);
  const rolesQ = useRoles(projectId);
  const agents = useAgents();
  const save = useSaveVariantDraft(projectId);
  const submit = useSubmitVariant(projectId);
  const rebase = useRebaseVariant(projectId);
  const toast = useToast();

  const roles = useMemo(() => rolesQ.data?.map((r) => r.definition) ?? [], [rolesQ.data]);
  const hiredRoleKeys = useMemo(
    () =>
      agents.data
        ? new Set(agents.data.filter((a) => a.status === 'active').map((a) => a.roleKey))
        : undefined,
    [agents.data],
  );
  const baseDef = useMemo(
    () => findBaseDefinition(catalogue.data, baseRef.key, baseRef.version),
    [catalogue.data, baseRef.key, baseRef.version],
  );
  // "Compare with previous": the approved variant when there is one, else the base the draft starts from.
  const compareWith = useMemo<{ label: string; def: WorkflowDefinition } | null>(() => {
    if (!baseDef) return null;
    const approved = base.variantSpec;
    if (isVariant && approved && !draft) {
      const b = findBaseDefinition(catalogue.data, approved.base.key, approved.base.version);
      const def = b && materialise(b, { ...approved, insertions: approved.insertions });
      if (def) return { label: `${base.name} v${base.version}`, def };
    }
    return { label: `${baseRef.key} v${baseRef.version} as it is`, def: baseDef };
  }, [baseDef, base, catalogue.data, draft, isVariant, baseRef.key, baseRef.version]);

  const edit = (next: EditorInsertion[]) => {
    setInsertions(next);
    setDirty(true);
    setServerIssues(undefined);
  };
  const errors = check?.errors ?? 0;
  const canSave = insertions.length > 0 && !waiting && (dirty || !draftId);
  const canSend = insertions.length > 0 && errors === 0 && !waiting;

  const persist = (then?: (id: string) => void) =>
    save.mutate(
      { id: draftId, spec: variantRequest(key, name, baseRef, insertions) },
      {
        onSuccess: (r) => {
          setDraftId(r.id);
          setServerIssues(r.issues);
          setDirty(false);
          if (then) {
            if (r.issues.some((i) => i.severity === 'error')) return;
            then(r.id);
          }
        },
      },
    );

  const sendNow = (id: string) =>
    submit.mutate(id, {
      onSuccess: () => {
        toast.success('Sent to the desk: the owner approves it before any card uses it');
        onOpenChange(false);
      },
    });
  const send = () => {
    if (draftId && !dirty) sendNow(draftId);
    else persist(sendNow);
  };

  const onValidation = useCallback((v: VariantCheck) => setCheck(v), []);
  const saved = !!draftId && !dirty && !save.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={isVariant ? `Edit steps of ${base.name}` : `Customise ${base.name} for ${projectKey}`}
      description="Add steps after existing ones. The steps of the base workflow cannot be changed."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {isVariant && base.baseUpdate && (
            <Button
              loading={rebase.isPending}
              disabled={dirty || waiting}
              title={dirty ? 'Save your changes first' : undefined}
              onClick={() =>
                rebase.mutate(base.versionId, {
                  onSuccess: () => {
                    toast.success(`Rebased on ${baseRef.key} v${base.baseUpdate?.version}: a new draft`);
                    onOpenChange(false);
                  },
                })
              }
            >
              Rebase on v{base.baseUpdate.version}
            </Button>
          )}
          <Button
            data-testid="variant-save"
            disabled={!canSave}
            loading={save.isPending && !submit.isPending}
            onClick={() => persist()}
          >
            Save draft
          </Button>
          <Button
            variant="primary"
            data-testid="variant-submit"
            disabled={!canSend}
            loading={submit.isPending}
            onClick={send}
          >
            Send for approval
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {waiting && (
          <Callout tone="info">
            Version {base.pendingVersion?.version} waits for the owner's approval on the desk. You can edit
            again after it is decided.
          </Callout>
        )}
        {!baseDef ? (
          catalogue.isError ? (
            <ErrorBox error={catalogue.error} />
          ) : (
            <p className="text-sm text-subtle" role="status">
              {catalogue.isPending
                ? 'Loading the base workflow...'
                : `The base workflow ${baseRef.key} v${baseRef.version} was not found.`}
            </p>
          )
        ) : (
          <VariantBuilder
            scope="project-variant"
            base={baseDef}
            variantKey={key}
            variantName={name}
            projectId={projectId}
            insertions={insertions}
            onChange={edit}
            roles={roles}
            hiredRoleKeys={hiredRoleKeys}
            serverIssues={serverIssues}
            readOnly={waiting}
            compareWith={compareWith}
            onValidation={onValidation}
            header={
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextInput
                    label="Key"
                    value={key}
                    disabled={isVariant || !!draftId}
                    hint="Lowercase letters, digits, - and _"
                    onChange={(e) => {
                      setKey(e.target.value);
                      setDirty(true);
                    }}
                  />
                  <TextInput
                    label="Name"
                    value={name}
                    disabled={waiting}
                    onChange={(e) => {
                      setName(e.target.value);
                      setDirty(true);
                      setServerIssues(undefined);
                    }}
                  />
                </div>
                <p className="text-sm text-muted">
                  Based on {baseRef.key} v{baseRef.version}. Running cards keep the version they started on; a
                  new version affects new cards only.
                </p>
              </>
            }
          />
        )}
        {saved && errors === 0 && insertions.length > 0 && (
          <p className="text-sm text-muted" data-testid="variant-saved">
            Draft saved. Nothing changes for cards until the owner approves it.
          </p>
        )}
        {dirty && insertions.length > 0 && (
          <p className="text-sm text-muted" data-testid="variant-unsaved">
            You have changes that are not saved yet.
          </p>
        )}
        <ErrorBox error={save.error ?? submit.error ?? rebase.error} />
      </div>
    </Dialog>
  );
}
