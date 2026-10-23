import {
  CEO_MODES,
  type CreateDiscoveryRequest,
  DISCOVERY_PLAYBOOKS,
  DISCOVERY_STANCES,
  type DiscoveryCeoMode,
  type DiscoveryPlaybook,
  type DiscoveryStance,
} from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { useCeoStatus } from '../../api/queries/ceo.ts';
import { useCreateDiscovery } from '../../api/queries/discovery.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import {
  CEO_MODE_HELP,
  CEO_MODE_LABEL,
  PLAYBOOK_LABEL,
  STANCE_HELP,
  STANCE_LABEL,
} from '../../lib/discovery.ts';
import { ModelSelect, toChoice, unionProviders } from '../ModelSelect.tsx';
import { Button, Dialog, ErrorBox, Select, TextArea, TextInput } from '../ui.tsx';

const TIME_BOXES = [
  { value: '', label: 'No time box' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '90', label: '90 minutes' },
];

/** "New discovery": title, project, stance, CEO mode (only when there is a CEO), time box, starting playbook and idea. */
export function NewDiscoveryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const nav = useNavigate();
  const create = useCreateDiscovery();
  const projects = useProjects();
  const ceo = useCeoStatus(open);
  const workstations = useWorkstations({ enabled: open });
  const wsList = workstations.data ?? [];
  const runtimes = [
    ...new Set(wsList.flatMap((w) => (w.runtimes ?? []).filter((r) => r.available).map((r) => r.id))),
  ];
  const [model, setModel] = useState('');
  const ceoAvailable = ceo.data?.state === 'active' || ceo.data?.state === 'offline';
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const [stance, setStance] = useState<DiscoveryStance>('facilitator');
  const [ceoMode, setCeoMode] = useState<DiscoveryCeoMode>('owner_only');
  const [timeBox, setTimeBox] = useState('');
  const [playbook, setPlaybook] = useState<DiscoveryPlaybook>('brainstorm');
  const [idea, setIdea] = useState('');
  const [budget, setBudget] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const body: CreateDiscoveryRequest = {
      title: title.trim(),
      stance,
      ceoMode: ceoAvailable ? ceoMode : 'owner_only',
      playbook,
      idea: idea.trim(),
      ...(toChoice(model) ? { model: toChoice(model) as NonNullable<ReturnType<typeof toChoice>> } : {}),
      ...(projectId ? { projectId } : {}),
      ...(timeBox ? { timeBoxMinutes: Number(timeBox) } : {}),
      ...(budget.trim() && Number(budget) > 0 ? { budgetUsd: Number(budget) } : {}),
    };
    create.mutate(body, {
      onSuccess: (s) => {
        onOpenChange(false);
        nav(`/discovery/${s.threadId}`);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New discovery"
      description="An analyst interviews you one question at a time and turns the answers into a brief or a PRD."
      size="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="new-discovery"
            loading={create.isPending}
            disabled={!title.trim()}
          >
            Start
          </Button>
        </>
      }
    >
      <form
        id="new-discovery"
        onSubmit={submit}
        className="flex flex-col gap-3.5"
        noValidate
        aria-label="New discovery"
      >
        <TextInput
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Invoicing for freelancers"
          maxLength={200}
        />
        <TextArea
          label="Starting idea (optional)"
          rows={3}
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="A sentence or two is plenty. The analyst asks the rest."
        />
        <Select label="Project (optional)" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">No project yet</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.key}: {p.name}
            </option>
          ))}
        </Select>
        <Select
          label="How should the analyst work?"
          value={stance}
          onChange={(e) => setStance(e.target.value as DiscoveryStance)}
          hint={STANCE_HELP[stance]}
        >
          {DISCOVERY_STANCES.map((s) => (
            <option key={s} value={s}>
              {STANCE_LABEL[s]}
            </option>
          ))}
        </Select>
        {ceoAvailable && (
          <Select
            label="CEO"
            value={ceoMode}
            onChange={(e) => setCeoMode(e.target.value as DiscoveryCeoMode)}
            hint={CEO_MODE_HELP[ceoMode]}
          >
            {CEO_MODES.map((m) => (
              <option key={m} value={m}>
                {CEO_MODE_LABEL[m]}
              </option>
            ))}
          </Select>
        )}
        <Select
          label="Start from"
          value={playbook}
          onChange={(e) => setPlaybook(e.target.value as DiscoveryPlaybook)}
        >
          {DISCOVERY_PLAYBOOKS.map((p) => (
            <option key={p} value={p}>
              {PLAYBOOK_LABEL[p]}
            </option>
          ))}
        </Select>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Select label="Time box" value={timeBox} onChange={(e) => setTimeBox(e.target.value)}>
            {TIME_BOXES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
          <TextInput
            label="Budget in USD (optional)"
            type="number"
            min="0.5"
            step="0.5"
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            hint="The session stops asking the model when it is used up."
          />
        </div>
        <ModelSelect
          label="Facilitator model (optional)"
          hint="Any model your workstation offers, a direct API provider included."
          value={model}
          onChange={setModel}
          runtimes={runtimes}
          providers={unionProviders(wsList)}
          defaultLabel="The facilitator's own"
        />
        <ErrorBox error={create.error} />
      </form>
    </Dialog>
  );
}
