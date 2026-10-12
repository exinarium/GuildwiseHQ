import { type DefinitionIssue, type ProjectWorkflowDto, roleClaimsStage } from '@aom/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useRoles } from '../api/queries/agents.ts';
import { useSaveVariantDraft, useSubmitVariant } from '../api/queries/project-workflows.ts';
import {
  baseStagesOf,
  type EditorInsertion,
  investigateInsertion,
  orderStages,
  slugId,
  suggestVariant,
  variantRequest,
} from '../lib/workflowVariant.ts';
import { Badge, Button, Callout, Dialog, ErrorBox, Select, TextArea, TextInput, useToast } from './ui.tsx';

type Template = 'investigate' | 'custom';

/**
 * "Customise" a workflow for one project (docs/design/architect-and-workflows.md 4.4): the base steps are listed read
 * only, with "Insert step after" between them. Every change is saved as a draft on the server, which answers with the
 * validation issues; a draft without errors can be sent to the owner's desk. Running cards keep their version.
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
  const [issues, setIssues] = useState<DefinitionIssue[]>([]);
  const [saved, setSaved] = useState(!!draft);
  const [adding, setAdding] = useState<string | null>(null);
  const roles = useRoles(projectId);
  const save = useSaveVariantDraft(projectId);
  const submit = useSubmitVariant(projectId);
  const toast = useToast();

  const stages = useMemo(() => orderStages(baseStagesOf(base), insertions), [base, insertions]);
  const errors = issues.filter((i) => i.severity === 'error');

  const persist = (next: EditorInsertion[]) => {
    setInsertions(next);
    if (next.length === 0) {
      setIssues([]);
      setSaved(false);
      return;
    }
    save.mutate(
      { id: draftId, spec: variantRequest(key, name, baseRef, next) },
      {
        onSuccess: (r) => {
          setDraftId(r.id);
          setIssues(r.issues);
          setSaved(true);
        },
        onError: () => setSaved(false),
      },
    );
  };

  const send = () => {
    if (!draftId) return;
    submit.mutate(draftId, {
      onSuccess: () => {
        toast.success('Sent to the desk: the owner approves it before any card uses it');
        onOpenChange(false);
      },
    });
  };

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
          <Button
            variant="primary"
            data-testid="variant-submit"
            disabled={!saved || errors.length > 0 || !draftId || waiting}
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
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label="Key"
            value={key}
            disabled={isVariant || !!draftId}
            hint="Lowercase letters, digits, - and _"
            onChange={(e) => setKey(e.target.value)}
          />
          <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="text-sm text-muted">
          Based on {baseRef.key} v{baseRef.version}. Running cards keep the version they started on; a new
          version affects new cards only.
        </p>
        <ol className="flex flex-col" data-testid="variant-stages" aria-label="Steps">
          {stages.map((s) => (
            <li key={s.id} className="flex flex-col">
              <div
                className={`flex flex-wrap items-center gap-2 rounded-control border px-3 py-2 text-sm ${
                  s.inserted ? 'border-brand bg-brand-soft' : 'border-line bg-surface'
                }`}
                data-testid={s.inserted ? 'inserted-stage' : 'base-stage'}
              >
                <span className="font-medium text-fg">{s.label}</span>
                <span className="font-mono text-xs text-subtle">{s.id}</span>
                {s.claimRole && <Badge>{s.claimRole}</Badge>}
                {s.inserted ? (
                  <>
                    <Badge tone="brand">new step</Badge>
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      className="ml-auto"
                      aria-label={`Remove step ${s.label}`}
                      disabled={waiting}
                      onClick={() => persist(insertions.filter((i) => i.stage.id !== s.id))}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                      Remove
                    </Button>
                  </>
                ) : (
                  <span className="ml-auto text-xs text-subtle">from {baseRef.key}, cannot be changed</span>
                )}
              </div>
              {s.kind !== 'terminal' && !waiting && (
                <div className="flex flex-col py-1 pl-4">
                  {adding === s.id ? (
                    <InsertForm
                      after={s}
                      variantKey={key}
                      roles={roles.data?.map((r) => r.definition) ?? []}
                      taken={stages.map((x) => x.id)}
                      onCancel={() => setAdding(null)}
                      onAdd={(ins) => {
                        setAdding(null);
                        persist([...insertions, ins]);
                      }}
                    />
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="self-start"
                      aria-label={`Insert step after ${s.label}`}
                      onClick={() => setAdding(s.id)}
                    >
                      <Plus aria-hidden="true" className="size-4" />
                      Insert step after {s.label}
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
        {issues.length > 0 && (
          <ul className="flex flex-col gap-1" data-testid="variant-issues" aria-label="Validation issues">
            {issues.map((i) => (
              <li
                key={`${i.code}-${i.stageId ?? ''}-${i.message}`}
                className={`text-sm ${i.severity === 'error' ? 'text-danger' : 'text-muted'}`}
              >
                {i.severity === 'error' ? 'Problem' : 'Note'}
                {i.stageId ? ` (${i.stageId})` : ''}: {i.message}
              </li>
            ))}
          </ul>
        )}
        {saved && errors.length === 0 && insertions.length > 0 && (
          <p className="text-sm text-muted" data-testid="variant-saved">
            Draft saved. Nothing changes for cards until the owner approves it.
          </p>
        )}
        <ErrorBox error={save.error ?? submit.error} />
      </div>
    </Dialog>
  );
}

function InsertForm({
  after,
  variantKey,
  roles,
  taken,
  onAdd,
  onCancel,
}: {
  after: { id: string; label: string };
  variantKey: string;
  roles: Array<Parameters<typeof roleClaimsStage>[0] & { key: string; name: string }>;
  taken: string[];
  onAdd: (ins: EditorInsertion) => void;
  onCancel: () => void;
}) {
  const hasArchitect = roles.some((r) => r.key === 'architect');
  const [template, setTemplate] = useState<Template>(hasArchitect ? 'investigate' : 'custom');
  const [label, setLabel] = useState(template === 'investigate' ? 'Investigate & design' : '');
  const [role, setRole] = useState(template === 'investigate' ? 'architect' : '');
  const [criteria, setCriteria] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pick = (t: Template) => {
    setTemplate(t);
    if (t === 'investigate') {
      setLabel('Investigate & design');
      setRole('architect');
      setCriteria('');
    } else {
      setLabel('');
      setRole('');
    }
  };
  const id = template === 'investigate' ? `investigate_after_${after.id}` : slugId(label);
  const can = (r: (typeof roles)[number]) => roleClaimsStage(r, variantKey, id);

  const add = () => {
    if (!label.trim()) return setError('Give the step a label');
    if (!id) return setError('The label needs letters or digits');
    if (taken.includes(id)) return setError(`A step '${id}' exists already: pick another label`);
    if (!role) return setError('Pick the role that works this step');
    if (template === 'custom' && !criteria.trim()) return setError('Say what done means for this step');
    if (template === 'investigate') {
      const t = investigateInsertion(after.id);
      onAdd({ ...t, stage: { ...t.stage, label: label.trim(), claimRole: role } });
      return;
    }
    onAdd({
      after: after.id,
      stage: { id, label: label.trim(), claimRole: role, doneCriteria: criteria.trim() },
    });
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-control border border-dashed border-line p-3"
      role="group"
      aria-label={`Insert a step after ${after.label}`}
    >
      <Select label="Template" value={template} onChange={(e) => pick(e.target.value as Template)}>
        {hasArchitect && <option value="investigate">Investigate &amp; design (architect)</option>}
        <option value="custom">Custom step</option>
      </Select>
      <TextInput label="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
      <Select
        label="Role"
        value={role}
        onChange={(e) => setRole(e.target.value)}
        disabled={template === 'investigate'}
      >
        <option value="">Pick a role</option>
        {roles.map((r) => (
          <option key={r.key} value={r.key}>
            {r.name}
            {id && !can(r) ? ' (cannot claim this step yet)' : ''}
          </option>
        ))}
      </Select>
      {template === 'custom' && (
        <>
          <TextArea
            label="Done when"
            hint="What the agent must have achieved before it reports the step done."
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
          />
          {id && roles.length > 0 && !roles.some(can) && (
            <p className="text-xs text-subtle">
              No role may claim{' '}
              <span className="font-mono">
                {variantKey}.{id}
              </span>{' '}
              yet. Create or extend a role in the Organization designer that claims it, then come back.
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={add}>
          Add step
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
