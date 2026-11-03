import { type JourneyDefinition, RECORD_TYPES, validateJourney } from '@aom/shared';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError, errorMessage } from '../api/client.ts';
import { useJourney, useSaveJourney, useStartJourneyInstance } from '../api/queries/journeys.ts';
import { useSlashCommands } from '../api/queries/playbooks.ts';
import { useProjectWorkflows } from '../api/queries/project-workflows.ts';
import { StartInstanceDialog } from '../components/journeys/StartInstanceDialog.tsx';
import { StepEditor } from '../components/journeys/StepEditor.tsx';
import {
  Button,
  Callout,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Select,
  TextArea,
  TextInput,
  useToast,
} from '../components/ui.tsx';
import {
  addHandoff,
  addStep,
  moveHandoff,
  moveStep,
  removeHandoff,
  removeStep,
  updateHandoff,
  updateStep,
} from '../lib/journeys.ts';

/** The journey designer: steps in order (Move up and Move down work on touch), handoffs per step, save and reopen. */
export function JourneyDesigner() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const q = useJourney(id);
  const save = useSaveJourney(id ?? '');
  const start = useStartJourneyInstance();
  const [def, setDef] = useState<JourneyDefinition | null>(null);
  const [dirty, setDirty] = useState(false);
  const [starting, setStarting] = useState(false);
  const projectId = q.data?.projectId;
  const wfs = useProjectWorkflows(projectId);
  const slash = useSlashCommands('session', projectId ? { projectId } : {});

  useEffect(() => {
    if (q.data && !dirty) setDef(q.data.definition);
  }, [q.data, dirty]);

  const workflows = useMemo(
    () => (wfs.data?.enabled ?? []).map((w) => ({ key: w.workflowKey, name: w.name })),
    [wfs.data],
  );
  const playbooks = useMemo(
    () => (slash.data?.items ?? []).filter((s) => s.kind === 'playbook').map((s) => ({ key: s.key, name: s.name })),
    [slash.data],
  );
  const issues = useMemo(
    () => (def ? validateJourney(def, wfs.data ? { enabledWorkflowKeys: workflows.map((w) => w.key) } : {}) : null),
    [def, wfs.data, workflows],
  );

  if (q.isLoading || !def) return q.error ? <ErrorBox error={q.error} /> : <PageSkeleton />;
  const canEdit = q.data?.canEdit ?? false;
  const edit = (next: JourneyDefinition) => {
    setDef(next);
    setDirty(true);
  };
  const onSave = () =>
    save.mutate(
      { definition: def, baseVersion: q.data?.currentVersion ?? 1 },
      {
        onSuccess: () => {
          setDirty(false);
          toast.success('Journey saved');
        },
        onError: (e) =>
          toast.error(e instanceof ApiError && e.status === 409 ? 'Someone else saved this journey: reload it first.' : errorMessage(e)),
      },
    );

  return (
    <div>
      <PageHeader
        title={def.name || 'Journey'}
        back={{ to: '/journeys', label: 'Journeys' }}
        sub={`Version ${q.data?.currentVersion}${dirty ? ' · unsaved changes' : ''}`}
        actions={
          <>
            {canEdit && (
              <Button onClick={onSave} loading={save.isPending} disabled={!dirty}>
                Save
              </Button>
            )}
            <Button variant="secondary" onClick={() => setStarting(true)} disabled={dirty || (issues?.errors.length ?? 0) > 0}>
              Start on a {def.recordType}
            </Button>
          </>
        }
      />
      {!canEdit && (
        <Callout tone="info" className="mb-4">
          Only the project owner and the organization Owner and Admins can change a journey.
        </Callout>
      )}
      {issues && (issues.errors.length > 0 || issues.warnings.length > 0) && (
        <Callout tone={issues.errors.length ? 'warning' : 'info'} title="Before you can start this journey" className="mb-4" role="status">
          <ul className="list-disc pl-5">
            {[...issues.errors, ...issues.warnings].map((i, n) => (
              <li key={`${i.code}-${n}`}>{i.message}</li>
            ))}
          </ul>
        </Callout>
      )}
      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <TextInput label="Name" value={def.name} disabled={!canEdit} onChange={(e) => edit({ ...def, name: e.target.value })} />
        <Select
          label="Works on a"
          value={def.recordType}
          disabled={!canEdit}
          onChange={(e) => edit({ ...def, recordType: e.target.value as JourneyDefinition['recordType'] })}
        >
          {RECORD_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <div className="sm:col-span-2">
          <TextArea label="Description" value={def.description} disabled={!canEdit} onChange={(e) => edit({ ...def, description: e.target.value })} />
        </div>
      </div>
      <ol className="flex flex-col gap-4" data-testid="journey-steps">
        {def.steps.map((s, i) => (
          <StepEditor
            key={s.id}
            def={def}
            step={s}
            index={i}
            workflows={workflows}
            playbooks={playbooks}
            disabled={!canEdit}
            onStep={(p) => edit(updateStep(def, s.id, p))}
            onMove={(d) => edit(moveStep(def, s.id, d))}
            onRemove={() => edit(removeStep(def, s.id))}
            onMakeFirst={() => edit({ ...def, firstStepId: s.id })}
            onAddHandoff={() => edit(addHandoff(def, s.id, def.steps[i + 1]?.id ?? 'end'))}
            onUpdateHandoff={(hid, p) => edit(updateHandoff(def, hid, p))}
            onMoveHandoff={(hid, d) => edit(moveHandoff(def, hid, d))}
            onRemoveHandoff={(hid) => edit(removeHandoff(def, hid))}
          />
        ))}
      </ol>
      {canEdit && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => edit(addStep(def, 'workflow', 'New step'))}>
            <Plus aria-hidden="true" className="size-4" /> Add a workflow step
          </Button>
          <Button variant="secondary" onClick={() => edit(addStep(def, 'wait', 'Wait'))}>
            Add a wait
          </Button>
          <Button variant="secondary" onClick={() => edit(addStep(def, 'gate', 'Approval'))}>
            Add a gate
          </Button>
        </div>
      )}
      <StartInstanceDialog
        open={starting}
        onOpenChange={setStarting}
        recordType={def.recordType}
        busy={start.isPending}
        error={start.error}
        onStart={(record) =>
          start.mutate({ journeyId: id ?? '', record }, { onSuccess: (r) => nav(`/journeys/instances/${r.id}`) })
        }
      />
    </div>
  );
}
