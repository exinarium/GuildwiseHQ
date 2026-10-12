import type { ProjectWorkflowDto } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  useDiscardVariant,
  useProjectWorkflows,
  useRebaseVariant,
  useSetProjectWorkflows,
} from '../api/queries/project-workflows.ts';
import { canCustomise } from '../lib/workflowVariant.ts';
import { Badge, Button, Callout, ErrorBox, Panel, Select, Spinner, useToast } from './ui.tsx';
import { WorkflowVariantEditor } from './WorkflowVariantEditor.tsx';

/**
 * Project settings, "Workflows" (#10): the workflows this project runs, which card types each is the default for, and
 * the project's own variants (steps inserted into a workflow). Owner and Admins change it; everyone sees it.
 */
export function ProjectWorkflows({ projectId, projectKey }: { projectId: string; projectKey: string }) {
  const q = useProjectWorkflows(projectId);
  const set = useSetProjectWorkflows(projectId);
  const rebase = useRebaseVariant(projectId);
  const discard = useDiscardVariant(projectId);
  const toast = useToast();
  const [editing, setEditing] = useState<ProjectWorkflowDto | null>(null);
  const [toEnable, setToEnable] = useState('');

  if (q.isPending)
    return (
      <Panel title="Workflows">
        <Spinner label="Loading workflows" />
      </Panel>
    );
  if (q.isError)
    return (
      <Panel title="Workflows">
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </Panel>
    );
  // Responses are only zod-checked in dev builds: stay safe on an unexpected body.
  const enabled = q.data.enabled ?? [];
  const available = q.data.available ?? [];
  const canEdit = q.data.canEdit ?? false;
  const enableable = available.filter((w) => !isPendingOnly(w));

  const current = () =>
    enabled.map((w) => ({ workflowKey: w.workflowKey, defaultCardTypes: w.defaultCardTypes }));
  const apply = (next: Array<{ workflowKey: string; defaultCardTypes: string[] }>, done?: string) =>
    set.mutate({ enabled: next }, { onSuccess: () => done && toast.success(done) });

  const toggleDefault = (key: string, type: string, on: boolean) =>
    apply(
      current().map((e) => ({
        ...e,
        defaultCardTypes: e.defaultCardTypes.filter((t) => t !== type || (e.workflowKey === key && on)),
        ...(e.workflowKey === key && on && !e.defaultCardTypes.includes(type)
          ? { defaultCardTypes: [...e.defaultCardTypes.filter((t) => t !== type), type] }
          : {}),
      })),
    );

  return (
    <Panel title="Workflows" data-testid="workflows-panel">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Cards run on one of these workflows. Pick which workflow is the default for each card type; when a
          card type has two choices, the new-card form lets you pick. Running cards always finish on the
          version they started on.
        </p>
        <ul className="flex flex-col divide-y divide-line" data-testid="enabled-workflows">
          {enabled.map((w) => (
            <li
              key={w.workflowKey}
              className="flex flex-col gap-2 py-3 first:pt-0"
              data-testid={`wf-${w.workflowKey}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-medium text-fg">{w.name}</span>
                <span className="font-mono text-xs text-subtle">
                  {w.workflowKey} v{w.version}
                </span>
                {w.isPrimary && <Badge tone="brand">Primary</Badge>}
                {w.variantOf && (
                  <Badge title="Steps inserted into another workflow">
                    based on {w.variantOf.key} v{w.variantOf.version}
                  </Badge>
                )}
                {w.baseUpdate && w.variantOf && (
                  <Badge tone="info">
                    {w.variantOf.key} v{w.baseUpdate.version} available
                  </Badge>
                )}
                <PendingBadge w={w} />
                {w.openCards > 0 && <span className="text-xs text-subtle">{w.openCards} open</span>}
              </div>
              <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <legend className="mb-1 text-xs text-subtle">Default for</legend>
                {w.cardTypes.map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={w.defaultCardTypes.includes(t)}
                      disabled={!canEdit || set.isPending}
                      aria-label={`${w.name} is the default for ${t} cards`}
                      onChange={(e) => toggleDefault(w.workflowKey, t, e.target.checked)}
                    />
                    {t}
                  </label>
                ))}
              </fieldset>
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  {(canCustomise(w) || w.variantOf) && (
                    <Button size="sm" onClick={() => setEditing(w)}>
                      {w.variantOf ? 'Edit steps' : 'Customise'}
                    </Button>
                  )}
                  {w.variantOf && w.baseUpdate && (
                    <Button
                      size="sm"
                      loading={rebase.isPending}
                      onClick={() =>
                        rebase.mutate(w.versionId, {
                          onSuccess: () =>
                            toast.success(
                              `Rebased on ${w.variantOf?.key} v${w.baseUpdate?.version}: a new draft`,
                            ),
                        })
                      }
                    >
                      Rebase on v{w.baseUpdate.version}
                    </Button>
                  )}
                  {w.pendingVersion?.status === 'draft' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => discard.mutate((w.pendingVersion as { id: string }).id)}
                    >
                      Discard draft
                    </Button>
                  )}
                  {!w.isPrimary && (
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      aria-label={`Disable ${w.name}`}
                      onClick={() =>
                        apply(
                          current().filter((e) => e.workflowKey !== w.workflowKey),
                          `${w.name} disabled`,
                        )
                      }
                    >
                      Disable
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {canEdit && enableable.length > 0 && (
          <div className="flex flex-wrap items-end gap-2">
            <Select
              label="Enable another workflow"
              value={toEnable}
              onChange={(e) => setToEnable(e.target.value)}
              className="min-w-56"
            >
              <option value="">Pick a workflow</option>
              {enableable.map((w) => (
                <option key={w.workflowKey} value={w.workflowKey}>
                  {w.name}
                  {w.variantOf ? ' (project variant)' : ''}
                </option>
              ))}
            </Select>
            <Button
              disabled={!toEnable}
              loading={set.isPending}
              onClick={() => {
                apply([...current(), { workflowKey: toEnable, defaultCardTypes: [] }], 'Workflow enabled');
                setToEnable('');
              }}
            >
              Enable
            </Button>
          </div>
        )}
        {available.filter(isPendingOnly).map((w) => (
          <Callout key={w.workflowKey} tone="info" data-testid={`wf-pending-${w.workflowKey}`}>
            <strong>{w.name}</strong> (a variant of {w.variantOf?.key}) is{' '}
            {w.pendingVersion?.status === 'draft' ? 'a draft' : "waiting for the owner's approval"}.{' '}
            {w.pendingVersion?.status === 'pending_approval' && (
              <Link to="/desk" className="underline">
                Open the desk
              </Link>
            )}
            {w.pendingVersion?.status === 'draft' && canEdit && (
              <Button size="sm" className="ml-2" onClick={() => setEditing(w)}>
                Continue
              </Button>
            )}
          </Callout>
        ))}
        {!canEdit && (
          <p className="text-xs text-subtle">
            Only the organization's Owner and Admins enable workflows and create variants.
          </p>
        )}
        <ErrorBox error={set.error ?? rebase.error ?? discard.error} />
      </div>
      {editing && (
        <WorkflowVariantEditor
          projectId={projectId}
          projectKey={projectKey}
          base={editing}
          open
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </Panel>
  );
}

/** A variant that has no approved version yet (its listed version is the pending one): it cannot be enabled. */
const isPendingOnly = (w: ProjectWorkflowDto) => !!w.pendingVersion && w.pendingVersion.version === w.version;

function PendingBadge({ w }: { w: ProjectWorkflowDto }) {
  const p = w.pendingVersion;
  if (!p || p.version === w.version) return null;
  return p.status === 'pending_approval' ? (
    <Badge tone="warning" title="The owner approves it on the desk before cards use it">
      v{p.version} waits for approval
    </Badge>
  ) : (
    <Badge tone="info">v{p.version} draft</Badge>
  );
}
