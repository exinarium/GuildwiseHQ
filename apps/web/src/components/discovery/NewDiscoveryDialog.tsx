import {
  CEO_MODES,
  type CreateDiscoveryRequest,
  DISCOVERY_PLAYBOOKS,
  DISCOVERY_PREP_TURN_CAP,
  DISCOVERY_PREP_TURN_CAP_MAX,
  DISCOVERY_PREP_TURN_CAP_MIN,
  DISCOVERY_STANCES,
  type DiscoveryCeoMode,
  type DiscoveryStance,
} from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { usableOnly, useCapabilities } from '../../api/queries/capabilities.ts';
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
import { TIME_LIMIT_PRESETS } from '../../lib/session.ts';
import { ModelSelect, toChoice, unionExtras, unionProviders } from '../ModelSelect.tsx';
import { WorkstationPicker } from '../session/WorkstationPicker.tsx';
import { Button, Dialog, ErrorBox, Select, TextArea, TextInput } from '../ui.tsx';

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
  const [playbook, setPlaybook] = useState<string>('brainstorm');
  const [templateKey, setTemplateKey] = useState('');
  const registry = useCapabilities({ kind: 'playbook', usable: true }, open);
  // Usable pack playbooks only: those tagged `discovery` start a session, those tagged `template:brief` or `template:prd` shape the draft.
  const packPlaybooks = usableOnly(registry.data?.items).filter(
    (i) => i.kind === 'playbook' && i.source === 'pack',
  );
  const startPlaybooks = packPlaybooks.filter((i) => (i.tags ?? []).includes('discovery'));
  const templates = packPlaybooks.filter((i) =>
    (i.tags ?? []).some((t) => t === 'template:brief' || t === 'template:prd'),
  );
  const [idea, setIdea] = useState('');
  const [budget, setBudget] = useState('');
  const [workstationId, setWorkstationId] = useState('');
  const [prepCap, setPrepCap] = useState(String(DISCOVERY_PREP_TURN_CAP));
  const prepN = Number(prepCap);
  const prepOk =
    Number.isInteger(prepN) && prepN >= DISCOVERY_PREP_TURN_CAP_MIN && prepN <= DISCOVERY_PREP_TURN_CAP_MAX;
  const prepMode = ceoAvailable && ceoMode === 'ceo_prep';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || (prepMode && !prepOk)) return;
    const body: CreateDiscoveryRequest = {
      title: title.trim(),
      stance,
      ceoMode: ceoAvailable ? ceoMode : 'owner_only',
      playbook,
      ...(templateKey ? { templateKey } : {}),
      idea: idea.trim(),
      ...(toChoice(model) ? { model: toChoice(model) as NonNullable<ReturnType<typeof toChoice>> } : {}),
      ...(projectId ? { projectId } : {}),
      ...(timeBox ? { timeBoxMinutes: Number(timeBox) } : {}),
      ...(budget.trim() && Number(budget) > 0 ? { budgetUsd: Number(budget) } : {}),
      ...(workstationId ? { workstationId } : {}),
      ...(prepMode ? { prepTurnCap: prepN } : {}),
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
            disabled={!title.trim() || (prepMode && !prepOk)}
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
        {prepMode && (
          <TextInput
            label="CEO pre-draft turns"
            type="number"
            min={DISCOVERY_PREP_TURN_CAP_MIN}
            max={DISCOVERY_PREP_TURN_CAP_MAX}
            step="1"
            value={prepCap}
            onChange={(e) => setPrepCap(e.target.value)}
            error={
              prepOk ? undefined : `Between ${DISCOVERY_PREP_TURN_CAP_MIN} and ${DISCOVERY_PREP_TURN_CAP_MAX}`
            }
            hint="How many answers the CEO drafts on its own before you review them."
            data-testid="prep-cap"
          />
        )}
        <WorkstationPicker value={workstationId} onChange={setWorkstationId} open={open} />
        <Select label="Start from" value={playbook} onChange={(e) => setPlaybook(e.target.value)}>
          {DISCOVERY_PLAYBOOKS.map((p) => (
            <option key={p} value={p}>
              {PLAYBOOK_LABEL[p]}
            </option>
          ))}
          {startPlaybooks.map((i) => (
            <option key={i.key} value={i.key}>
              {i.name} ({i.pack ?? 'pack'})
            </option>
          ))}
        </Select>
        {templates.length > 0 && (
          <Select
            label="Document template (optional)"
            value={templateKey}
            onChange={(e) => setTemplateKey(e.target.value)}
            hint="A brief or PRD template from an approved pack."
          >
            <option value="">The standard layout</option>
            {templates.map((i) => (
              <option key={i.key} value={i.key}>
                {i.name} ({i.pack ?? 'pack'})
              </option>
            ))}
          </Select>
        )}
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Select
            label="Time limit"
            value={timeBox}
            onChange={(e) => setTimeBox(e.target.value)}
            hint="Optional. Like a meeting: you see the time left, and choose what happens when it is up."
          >
            {TIME_LIMIT_PRESETS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
          <TextInput
            label="Cost limit in USD (optional)"
            type="number"
            min="0.5"
            step="0.5"
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            hint="Empty means no limit. A limit stops the session asking the model when it is used up."
          />
        </div>
        <ModelSelect
          label="Facilitator model (optional)"
          hint="Any model your workstation offers, a direct API provider included."
          value={model}
          onChange={setModel}
          runtimes={runtimes}
          providers={unionProviders(wsList)}
          extras={unionExtras(wsList)}
          defaultLabel="The facilitator's own"
        />
        <ErrorBox error={create.error} />
      </form>
    </Dialog>
  );
}
