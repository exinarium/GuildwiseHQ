import { type HirePackAgentsRequest, modelChoicesFor, type PackSeat } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useRoles } from '../../api/queries/agents.ts';
import { useMe } from '../../api/queries/auth.ts';
import { usePacks } from '../../api/queries/capabilities.ts';
import { useHirablePacks } from '../../api/queries/my-capabilities.ts';
import { packHireMessage, useHirePackAgent, usePackTeam } from '../../api/queries/pack-team.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import { getLastProjectKey } from '../../lib/lastProject.ts';
import { agentWarning, isRuntimeUnsandboxed, sandboxReasonOf } from '../../lib/sandbox.ts';
import { unionExtras } from '../ModelSelect.tsx';
import { SandboxWarning } from '../SandboxWarning.tsx';
import { Button, Callout, ListSkeleton, Select, TextInput } from '../ui.tsx';
import { type Access, ProjectAccessEditor } from './ProjectAccess.tsx';

const MAX_LISTED = 100;

/**
 * "From a pack" in the hire form: one agent of an approved pack, on a built-in role as its seat (or a role of its own). It
 * joins the agents already on that seat. The seat decides permissions, gates and workflow steps; the pack agent supplies the
 * name, the approach and its skills.
 */
export function HirePackAgentForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const me = useMe();
  const isManager = me.data?.activeOrg?.role === 'owner' || me.data?.activeOrg?.role === 'admin';
  // Owners and Admins see every approved organization pack (also one that only has skills marked as agents); a member, the
  // approved packs with personas.
  const adminPacks = usePacks();
  const hirable = useHirablePacks();
  const packList = isManager
    ? (adminPacks.data?.packs ?? [])
        .filter((p) => p.trusted && p.visibility !== 'private')
        .map((p) => ({ id: p.id, name: p.name }))
    : (hirable.data?.packs ?? [])
        .filter((p) => p.visibility !== 'private')
        .map((p) => ({ id: p.id, name: p.name }));
  const listPending = isManager ? adminPacks.isPending : hirable.isPending;
  const [packId, setPackId] = useState('');
  const effectivePack = packId || packList[0]?.id || '';
  const team = usePackTeam(effectivePack || null);
  const roles = useRoles();
  const stations = useWorkstations();
  const projects = useProjects();
  const hire = useHirePackAgent(effectivePack);
  const [search, setSearch] = useState('');
  const [agentKey, setAgentKey] = useState('');
  const [seatPick, setSeatPick] = useState<PackSeat | ''>('');
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [skillPick, setSkillPick] = useState<string[] | null>(null);
  const [seniority, setSeniority] = useState('');
  const [model, setModel] = useState('');
  const [runtime, setRuntime] = useState('');
  const [workstationId, setWorkstationId] = useState('');
  const [access, setAccess] = useState<Access | null>(null);
  const [ackedFor, setAckedFor] = useState('');
  const [serverWantsAck, setServerWantsAck] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const needle = search.trim().toLowerCase();
  const agents = (team.data?.agents ?? []).filter(
    (a) => !needle || `${a.key} ${a.name} ${a.description}`.toLowerCase().includes(needle),
  );
  const chosen = (team.data?.agents ?? []).find((a) => a.key === agentKey) ?? agents[0];
  const seat: PackSeat = seatPick || chosen?.suggestedSeat || 'own';
  const seatRole = roles.data?.find((r) => r.definition.key === seat)?.definition;
  const name = nameEdit ?? chosen?.name ?? '';
  const refs = skillPick ?? chosen?.skillRefs ?? [];

  const mine = (stations.data ?? []).filter((w) => w.userId === me.data?.user?.id && w.status === 'active');
  const station = mine.find((w) => w.id === (workstationId || mine[0]?.id));
  const runtimeOptions = [
    ...new Set(
      (station?.runtimes ?? []).filter((r) => r.available && r.id !== 'direct-model').map((r) => r.id),
    ),
  ];
  const effectiveRuntime = runtime || seatRole?.defaultModel.runtime || 'claude-code';
  const unsandboxed = !!station && isRuntimeUnsandboxed(station.runtimes, effectiveRuntime);
  const needsAck = unsandboxed || serverWantsAck;
  const ackKey = `${station?.id}:${effectiveRuntime}`;
  const acked = ackedFor === ackKey;
  const modelSuggestions = modelChoicesFor(
    [effectiveRuntime],
    [],
    unionExtras(station ? [station] : []),
  ).flatMap((g) => g.models.map((m) => m.id));

  const activeOrgId = me.data?.activeOrg?.id;
  const defaultProject =
    projects.data?.find((p) => p.key === getLastProjectKey())?.id ||
    projects.data?.find((p) => p.orgId === activeOrgId)?.id ||
    projects.data?.[0]?.id ||
    '';
  const effectiveAccess: Access = access ?? { allowed: defaultProject ? [defaultProject] : null, focus: [] };

  const pickAgent = (key: string) => {
    setAgentKey(key);
    setSeatPick('');
    setNameEdit(null);
    setSkillPick(null);
    setSeniority('');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!chosen) errs.agent = 'Choose a pack agent';
    if (!name.trim()) errs.name = 'A name is required';
    if (!station) errs.workstation = 'Add a workstation first';
    if (needsAck && !acked) errs.sandbox = 'Confirm that you accept hiring onto an unsandboxed workstation';
    if (!isManager && (effectiveAccess.allowed?.length ?? 0) === 0)
      errs.access = 'Pick at least one project you are on';
    if (isManager && effectiveAccess.allowed !== null && effectiveAccess.allowed.length === 0)
      errs.access = 'Pick at least one project, or allow any project';
    setErrors(errs);
    if (Object.keys(errs).length || !chosen || !station) return;
    const body: HirePackAgentsRequest = {
      items: [
        {
          key: chosen.key,
          seat,
          count: 1,
          // the pack agent's own name is left to the server, which makes it unique
          ...(name.trim() !== chosen.name ? { name: name.trim() } : {}),
          ...(seniority ? { seniority: seniority as 'junior' | 'senior' } : {}),
          ...(model.trim() ? { model: model.trim() } : {}),
          ...(skillPick ? { skills: skillPick } : {}),
        },
      ],
      workstationId: station.id,
      capacity: 1,
      ...(runtime ? { runtime } : {}),
      allowedProjectIds: effectiveAccess.allowed,
      ...(needsAck && acked ? { acknowledgeUnsandboxed: true } : {}),
    };
    hire.mutate(body, {
      onSuccess: onDone,
      onError: (er) => {
        if ((er as { code?: string }).code === 'unsandboxed_ack_required') setServerWantsAck(true);
      },
    });
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Hire from a pack"
      className="flex flex-col gap-3"
      data-testid="hire-from-pack-form"
    >
      {listPending && <ListSkeleton label="Loading packs" rows={1} />}
      {!listPending && packList.length === 0 && (
        <Callout tone="info">
          No approved pack yet. An Owner or Admin adds a pack under Settings &gt; Capabilities and approves
          it.
        </Callout>
      )}
      {packList.length > 0 && (
        <Select
          label="Pack"
          value={effectivePack}
          onChange={(e) => {
            setPackId(e.target.value);
            pickAgent('');
            setSearch('');
          }}
        >
          {packList.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      )}
      {team.isPending && effectivePack && <ListSkeleton label="Loading the pack's agents" rows={1} />}
      {team.data && team.data.agents.length === 0 && (
        <p className="text-sm text-muted">
          This pack has no agents. An Owner or Admin can mark skills as agents on the pack.
        </p>
      )}
      {team.data && team.data.agents.length > 0 && (
        <>
          <div>
            {team.data.agents.length > 8 && (
              <TextInput
                label="Search the pack's agents"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            )}
            <Select
              label="Pack agent"
              value={chosen?.key ?? ''}
              onChange={(e) => pickAgent(e.target.value)}
              error={errors.agent}
              hint={chosen?.description ? chosen.description.slice(0, 160) : undefined}
            >
              {agents.slice(0, MAX_LISTED).map((a) => (
                <option key={a.key} value={a.key}>
                  {a.name}
                </option>
              ))}
            </Select>
            {agents.length > MAX_LISTED && (
              <p className="mt-1 text-xs text-subtle">
                Showing {MAX_LISTED} of {agents.length}: search to narrow.
              </p>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Seat"
              value={seat}
              onChange={(e) => {
                setSeatPick(e.target.value as PackSeat);
                setSeniority('');
              }}
              hint="The built-in role decides what it may do, its gates and the workflow steps it takes. The agent joins those already on it."
            >
              {team.data.seats.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                  {chosen?.suggestedSeat === s.key ? ' (suggested)' : ''}
                </option>
              ))}
              <option value="own">Own role{chosen?.suggestedSeat === 'own' ? ' (suggested)' : ''}</option>
            </Select>
            <TextInput
              label="Name"
              value={name}
              onChange={(e) => setNameEdit(e.target.value)}
              error={errors.name}
              maxLength={60}
            />
            <Select label="Seniority" value={seniority} onChange={(e) => setSeniority(e.target.value)}>
              <option value="">Default ({seatRole?.seniorityLevels[0] ?? 'senior'})</option>
              {(seatRole?.seniorityLevels ?? ['senior', 'junior']).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            <Select
              label="Workstation"
              value={station?.id ?? ''}
              onChange={(e) => setWorkstationId(e.target.value)}
              error={errors.workstation}
            >
              {mine.length === 0 && <option value="">No workstation of yours is active</option>}
              {mine.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} {w.connected ? '(connected)' : '(offline)'}
                </option>
              ))}
            </Select>
            <Select label="Runtime" value={runtime} onChange={(e) => setRuntime(e.target.value)}>
              <option value="">Default ({seatRole?.defaultModel.runtime ?? 'claude-code'})</option>
              {runtimeOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
            <div>
              <TextInput
                label="Model"
                value={model}
                list="pack-hire-model-suggestions"
                placeholder={seatRole?.defaultModel.model}
                onChange={(e) => setModel(e.target.value)}
              />
              <datalist id="pack-hire-model-suggestions">
                {modelSuggestions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
          </div>
          {chosen && (chosen.agentSkill || chosen.skillRefs.length > 0) && (
            <fieldset className="flex flex-col gap-1 text-sm" data-testid="pack-agent-skills">
              <legend className="font-medium">Skills</legend>
              {chosen.agentSkill && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked
                    disabled
                    aria-label={`Skill ${chosen.agentSkill} (always)`}
                  />
                  <code>{chosen.agentSkill}</code>
                  <span className="text-xs text-subtle">the agent itself, always</span>
                </label>
              )}
              {chosen.skillRefs.map((k) => (
                <label key={k} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={refs.includes(k)}
                    onChange={(e) =>
                      setSkillPick(
                        e.target.checked ? [...new Set([...refs, k])] : refs.filter((x) => x !== k),
                      )
                    }
                    aria-label={`Skill ${k}`}
                  />
                  <code>{k}</code>
                </label>
              ))}
            </fieldset>
          )}
          <div>
            <ProjectAccessEditor
              value={effectiveAccess}
              onChange={setAccess}
              projects={projects.data ?? []}
              canAny={isManager}
              idPrefix="packagent"
            />
            {errors.access && (
              <p role="alert" className="mt-1 text-sm font-medium text-danger">
                {errors.access}
              </p>
            )}
          </div>
          {needsAck && station && (
            <div className="flex flex-col gap-2" data-testid="pack-hire-unsandboxed">
              <SandboxWarning testId="pack-hire-sandbox-warning" role="alert" lead="Warning:">
                {agentWarning(station.name, sandboxReasonOf(station.runtimes, effectiveRuntime))}
              </SandboxWarning>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={acked}
                  onChange={(e) => setAckedFor(e.target.checked ? ackKey : '')}
                />
                <span>I understand this agent runs without an OS sandbox on {station.name}</span>
              </label>
              {errors.sandbox && (
                <p role="alert" className="text-sm text-danger">
                  {errors.sandbox}
                </p>
              )}
            </div>
          )}
        </>
      )}
      {hire.error && (
        <Callout tone="danger" role="alert" data-testid="pack-hire-error">
          {packHireMessage(hire.error)}
        </Callout>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={hire.isPending || !chosen} loading={hire.isPending}>
          Hire
        </Button>
      </div>
    </form>
  );
}
