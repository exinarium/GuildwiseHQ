import type { FollowupSpec } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  useCreatePhase,
  useDeployTargets,
  useFollowupDefaults,
  usePhases,
  useSetFollowupDefaults,
} from '../api/queries/phases.ts';
import { PHASE_STATUS_LABEL, phasePath, phaseTone, withoutIds } from '../lib/phases.ts';
import { FollowupEditor, followupProblems } from './FollowupEditor.tsx';
import { Badge, Button, Dialog, ErrorBox, Panel, TextArea, TextInput } from './ui.tsx';

/** The project's phases (a list with status) and a dialog to start a new one. */
export function PhasesPanel({ projectId }: { projectId: string }) {
  const phases = usePhases(projectId);
  const [open, setOpen] = useState(false);
  return (
    <Panel data-testid="phases-panel">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Phases</h2>
        <Button data-testid="new-phase" onClick={() => setOpen(true)}>
          New phase
        </Button>
      </div>
      <ul className="flex flex-col gap-1.5" data-testid="phase-list">
        {(phases.data ?? []).map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
            <Link to={phasePath(p.ref)} className="font-mono text-xs underline">
              {p.ref}
            </Link>
            <span className="font-medium">{p.name}</span>
            <Badge tone={phaseTone(p.status)}>{PHASE_STATUS_LABEL[p.status]}</Badge>
            <span className="text-xs text-subtle">
              {p.resolvedCount}/{p.memberCount} cards done
              {p.proposedCount > 0 ? `, ${p.proposedCount} proposed` : ''}
            </span>
          </li>
        ))}
        {phases.data?.length === 0 && (
          <li className="text-sm text-subtle">
            No phases yet. A phase groups cards you want to ship and check together, then deploys and tests
            them.
          </li>
        )}
      </ul>
      <NewPhaseDialog projectId={projectId} open={open} onOpenChange={setOpen} />
    </Panel>
  );
}

function NewPhaseDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const defaults = useFollowupDefaults(projectId);
  const targets = useDeployTargets(projectId);
  const create = useCreatePhase(projectId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [followups, setFollowups] = useState<FollowupSpec[] | null>(null);
  const [err, setErr] = useState('');
  const list = followups ?? withoutIds(defaults.data ?? []);
  const t = targets.data ?? [];
  const submit = () => {
    if (!name.trim()) return setErr('A name is required');
    if (followupProblems(list, t).length) return setErr('Fix the follow-ups first');
    setErr('');
    create.mutate(
      {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        followups: list,
      },
      {
        onSuccess: () => {
          setName('');
          setDescription('');
          setFollowups(null);
          onOpenChange(false);
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New phase"
      description="Cards join it from their page or the phase page."
    >
      <div className="flex flex-col gap-3" data-testid="new-phase-dialog">
        <TextInput
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={err && !name.trim() ? err : undefined}
        />
        <TextArea
          label="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted">Follow-ups after the phase</h3>
          <FollowupEditor value={list} onChange={setFollowups} targets={t} />
        </div>
        {err && name.trim() && (
          <p role="alert" className="text-xs font-medium text-danger">
            {err}
          </p>
        )}
        <ErrorBox error={create.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" data-testid="create-phase" disabled={create.isPending} onClick={submit}>
            Create phase
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** The follow-ups a new phase starts with (every member can change them). */
export function FollowupDefaultsPanel({ projectId }: { projectId: string }) {
  const defaults = useFollowupDefaults(projectId);
  const targets = useDeployTargets(projectId);
  const save = useSetFollowupDefaults(projectId);
  const [draft, setDraft] = useState<FollowupSpec[] | null>(null);
  const list = draft ?? defaults.data ?? [];
  const t = targets.data ?? [];
  return (
    <Panel data-testid="followup-defaults">
      <h2 className="mb-1 text-sm font-semibold">Default follow-ups</h2>
      <p className="mb-2 text-xs text-subtle">
        New phases start with these. Each phase can still change them until you approve.
      </p>
      <FollowupEditor value={list} onChange={setDraft} targets={t} />
      <ErrorBox error={save.error} />
      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="primary"
          data-testid="save-defaults"
          disabled={save.isPending || draft === null || followupProblems(list, t).length > 0}
          onClick={() => save.mutate(list, { onSuccess: () => setDraft(null) })}
        >
          Save defaults
        </Button>
        {save.isSuccess && draft === null && (
          <span role="status" className="text-sm text-success">
            Saved.
          </span>
        )}
      </div>
    </Panel>
  );
}
