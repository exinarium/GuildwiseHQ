import type { AgentDto } from '@aom/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useAgents, useFire, useHire, useNameSuggestions, useRoles } from '../api/queries/agents.ts';
import { useMe } from '../api/queries/auth.ts';
import { useResetAgent } from '../api/queries/devops.ts';
import { useRehomeAgent } from '../api/queries/members.ts';
import { useProjects } from '../api/queries/projects.ts';
import { useWorkstations } from '../api/queries/workstations.ts';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  ErrorBox,
  PageHeader,
  Panel,
  Select,
  Spinner,
  TextInput,
} from '../components/ui.tsx';
import { roleCap } from '../lib/hireCaps.ts';
import { getLastProjectKey } from '../lib/lastProject.ts';

export function Agents() {
  const agents = useAgents();
  const roles = useRoles();
  const workstations = useWorkstations();
  const [hireOpen, setHireOpen] = useState(false);
  const [firing, setFiring] = useState<AgentDto | null>(null);
  const [rehoming, setRehoming] = useState<AgentDto | null>(null);
  const [projectFilter, setProjectFilter] = useState('');
  const me = useMe();
  const projects = useProjects();
  const reset = useResetAgent();
  const myId = me.data?.user.id;
  /** The org owner may change and fire any agent; a member only the ones they hired themselves. */
  const canManage = (a: AgentDto) => !!myId && (myId === a.orgId || myId === a.managerUserId);
  const roleName = (k: string) => roles.data?.find((r) => r.definition.key === k)?.definition.name ?? k;
  const stationName = (id: string | null) => workstations.data?.find((w) => w.id === id)?.name ?? '';
  const inFilter = (a: AgentDto) =>
    !projectFilter || a.projectId === projectFilter || (a.projectId === null && !a.isDevops);
  const active = agents.data?.filter((a) => a.status !== 'retired' && inFilter(a)) ?? [];
  const retired = agents.data?.filter((a) => a.status === 'retired') ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Agents"
        actions={
          <Button variant="primary" onClick={() => setHireOpen(true)}>
            Hire agent
          </Button>
        }
      />
      {(projects.data?.length ?? 0) > 1 && (
        <div className="mb-3 max-w-xs">
          <Select label="Project" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="">All projects</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} {p.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {agents.isPending && <Spinner />}
      {agents.isError && <ErrorBox error={agents.error} />}
      <ErrorBox error={reset.error} />
      {agents.data && active.length === 0 && (
        <Panel>
          <p className="text-sm text-zinc-500">No agents hired yet.</p>
        </Panel>
      )}
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="agents">
        {active.map((a) => (
          <li key={a.id} data-testid={`agent-${a.name}`} data-editable={canManage(a) ? 'true' : 'false'}>
            <Panel className="flex h-full flex-col gap-2">
              <div className="flex items-center gap-2">
                <Avatar name={a.name} size={36} />
                <div className="min-w-0">
                  <p className="truncate font-medium">{a.name}</p>
                  <p className="text-xs text-zinc-500">
                    {roleName(a.roleKey)} · {a.seniority}
                    {a.projectId &&
                      ` · ${projects.data?.find((p) => p.id === a.projectId)?.key ?? 'shared project'}`}
                  </p>
                </div>
                <span className="ml-auto">
                  {a.status === 'needs_rehome' ? (
                    <Badge tone="amber">needs rehome</Badge>
                  ) : a.activeCards.length ? (
                    <Badge tone="blue">on shift</Badge>
                  ) : (
                    <Badge>idle</Badge>
                  )}
                </span>
              </div>
              <p className="text-xs text-zinc-500">
                {a.runtime} · {a.model}
                {a.effort ? ` · ${a.effort}` : ''}
                {stationName(a.workstationId) && ` · ${stationName(a.workstationId)}`}
              </p>
              <p className="text-sm" data-testid="agent-current-card">
                {a.activeCards.length === 0
                  ? 'No current card'
                  : a.activeCards.map((c) => (
                      <Link key={c.cardId} to={`/cards/${c.ref}`} className="underline">
                        {c.ref} {c.title}
                      </Link>
                    ))}
              </p>
              {a.isDevops ? (
                <div className="mt-auto flex items-center gap-2">
                  <Badge tone="violet">DevOps engineer</Badge>
                  {canManage(a) && (
                    <Button
                      variant="ghost"
                      aria-label={`Reset ${a.name}`}
                      disabled={reset.isPending}
                      onClick={() => reset.mutate(a.id)}
                    >
                      Reset
                    </Button>
                  )}
                </div>
              ) : canManage(a) ? (
                <div className="mt-auto flex gap-2">
                  {a.status === 'needs_rehome' && (
                    <Button variant="primary" aria-label={`Re-home ${a.name}`} onClick={() => setRehoming(a)}>
                      Re-home
                    </Button>
                  )}
                  <Button variant="ghost" aria-label={`Fire ${a.name}`} onClick={() => setFiring(a)}>
                    Fire
                  </Button>
                </div>
              ) : (
                <p className="mt-auto text-xs text-zinc-500" data-testid="agent-readonly">
                  Hired by another manager (read only)
                </p>
              )}
            </Panel>
          </li>
        ))}
      </ul>
      {retired.length > 0 && (
        <details className="mt-4 text-sm text-zinc-500">
          <summary className="cursor-pointer">Retired ({retired.length})</summary>
          <ul className="mt-1">
            {retired.map((a) => (
              <li key={a.id}>
                {a.name} · {roleName(a.roleKey)}
              </li>
            ))}
          </ul>
        </details>
      )}
      <HireDialog open={hireOpen} onOpenChange={setHireOpen} agents={agents.data ?? []} />
      <FireDialog agent={firing} onClose={() => setFiring(null)} />
      <RehomeDialog agent={rehoming} onClose={() => setRehoming(null)} />
    </div>
  );
}

/** A removed manager's agent needs a new home: one of your own workstations and runtime. Name and history carry over. */
function RehomeDialog({ agent, onClose }: { agent: AgentDto | null; onClose: () => void }) {
  const stations = useWorkstations();
  const rehome = useRehomeAgent();
  const active = (stations.data ?? []).filter((w) => w.status === 'active');
  const [stationId, setStationId] = useState('');
  const [runtime, setRuntime] = useState('');
  const [model, setModel] = useState('');
  const eff = stationId || active[0]?.id || '';
  const station = active.find((w) => w.id === eff);
  const runtimes = station?.runtimes.filter((r) => r.available).map((r) => r.id) ?? [];
  const effRuntime = runtime && runtimes.includes(runtime) ? runtime : (runtimes[0] ?? agent?.runtime ?? '');
  return (
    <Dialog
      open={!!agent}
      onOpenChange={(o) => !o && onClose()}
      title={`Re-home ${agent?.name ?? ''}`}
      description="Pick one of your workstations and a runtime. The name, history and track record carry over; the old sandbox stays behind."
    >
      {agent && (
        <form
          aria-label="Re-home agent"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!eff) return;
            rehome.mutate(
              {
                agentId: agent.id,
                workstationId: eff,
                runtime: effRuntime,
                model: model.trim() || agent.model,
              },
              { onSuccess: onClose },
            );
          }}
        >
          <Select label="Workstation" value={eff} onChange={(e) => setStationId(e.target.value)}>
            {active.length === 0 && <option value="">No workstation paired</option>}
            {active.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} {w.connected ? '(connected)' : '(offline)'}
              </option>
            ))}
          </Select>
          <Select label="Runtime" value={effRuntime} onChange={(e) => setRuntime(e.target.value)}>
            {(runtimes.length ? runtimes : [agent.runtime]).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <TextInput
            label="Model"
            placeholder={agent.model}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <ErrorBox error={rehome.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={rehome.isPending || !eff}>
              Re-home
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function FireDialog({ agent, onClose }: { agent: AgentDto | null; onClose: () => void }) {
  const fire = useFire();
  return (
    <Dialog
      open={!!agent}
      onOpenChange={(o) => !o && onClose()}
      title={`Fire ${agent?.name ?? ''}?`}
      description="The agent is retired and its sandbox wiped. Its name is never reused."
    >
      {agent && (
        <div className="flex flex-col gap-3">
          {agent.activeCards.length ? (
            <div data-testid="fire-releases">
              <p className="text-sm font-medium">These cards will be released back to the queue:</p>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {agent.activeCards.map((c) => (
                  <li key={c.cardId}>
                    {c.ref} {c.title}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-zinc-500" data-testid="fire-releases">
              This agent holds no cards. Nothing will be released.
            </p>
          )}
          <ErrorBox error={fire.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="danger"
              disabled={fire.isPending}
              onClick={() => fire.mutate(agent.id, { onSuccess: onClose })}
            >
              Confirm fire
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function HireDialog({
  open,
  onOpenChange,
  agents,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  agents: AgentDto[];
}) {
  const roles = useRoles();
  const stations = useWorkstations();
  const projects = useProjects();
  const hire = useHire();
  const [nonce, setNonce] = useState(0);
  const suggestions = useNameSuggestions(open, nonce);
  const [roleKey, setRoleKey] = useState('');
  const [seniority, setSeniority] = useState('');
  const [workstationId, setWorkstationId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [runtime, setRuntime] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [skills, setSkills] = useState('');
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const hireable = useMemo(
    () => (roles.data ?? []).filter((r) => r.definition.key !== 'devops'),
    [roles.data],
  );
  const caps = useMemo(
    () => hireable.map((r) => roleCap(r.definition.key, r.definition.name, agents)),
    [hireable, agents],
  );
  const activeStations = (stations.data ?? []).filter((w) => w.status === 'active');
  const firstOpen = hireable.find((r) => !caps.find((c) => c.roleKey === r.definition.key)?.full);
  const effectiveRoleKey = roleKey || firstOpen?.definition.key || '';
  const role = hireable.find((r) => r.definition.key === effectiveRoleKey)?.definition;
  const effectiveSeniority =
    seniority && role?.seniorityLevels.includes(seniority as 'junior')
      ? seniority
      : (role?.seniorityLevels[0] ?? '');
  const effectiveStation = workstationId || activeStations[0]?.id || '';
  const effectiveProject =
    projectId ||
    projects.data?.find((p) => p.key === getLastProjectKey())?.id ||
    projects.data?.[0]?.id ||
    '';
  const station = activeStations.find((w) => w.id === effectiveStation);
  const runtimeOptions = [
    ...new Set(
      [
        role?.defaultModel.runtime,
        ...(station?.runtimes.filter((r) => r.available).map((r) => r.id) ?? []),
      ].filter(Boolean) as string[],
    ),
  ];
  const full = caps.find((c) => c.roleKey === effectiveRoleKey)?.full ?? false;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!role) errs.role = 'Choose a role';
    if (full) errs.role = 'This role is at its limit';
    if (!name.trim()) errs.name = 'A name is required';
    if (!effectiveStation) errs.workstation = 'Pair a workstation first';
    setErrors(errs);
    if (Object.keys(errs).length || !role) return;
    hire.mutate(
      {
        name: name.trim(),
        roleKey: role.key,
        seniority: effectiveSeniority as 'junior' | 'senior',
        workstationId: effectiveStation,
        ...(effectiveProject ? { projectId: effectiveProject } : {}),
        ...(runtime ? { runtime } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(effort ? { effort } : {}),
        skills: skills
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        capacity: 1,
      },
      {
        onSuccess: () => {
          setName('');
          setNonce((n) => n + 1);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Hire agent"
      description="Hire an agent onto one of your workstations."
    >
      <form onSubmit={submit} noValidate aria-label="Hire agent" className="flex flex-col gap-3">
        <Select
          label="Role"
          value={effectiveRoleKey}
          onChange={(e) => setRoleKey(e.target.value)}
          error={errors.role}
        >
          {hireable.map((r) => {
            const c = caps.find((x) => x.roleKey === r.definition.key);
            return (
              <option key={r.definition.key} value={r.definition.key} disabled={c?.full}>
                {r.definition.name}
                {c?.full ? ` (limit reached ${c.active}/${c.cap})` : ''}
              </option>
            );
          })}
        </Select>
        <ul className="-mt-1 text-xs text-zinc-500" data-testid="hire-caps" aria-label="Role limits">
          {caps
            .filter((c) => c.full)
            .map((c) => (
              <li key={c.roleKey} className="text-amber-700 dark:text-amber-400">
                {c.reason}
              </li>
            ))}
          {caps.every((c) => !c.full) && <li>First-run limits: 2 builders, 1 of each other role.</li>}
        </ul>
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Seniority" value={effectiveSeniority} onChange={(e) => setSeniority(e.target.value)}>
            {(role?.seniorityLevels ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select
            label="Workstation"
            value={effectiveStation}
            onChange={(e) => setWorkstationId(e.target.value)}
            error={errors.workstation}
          >
            {activeStations.length === 0 && <option value="">No workstation paired</option>}
            {activeStations.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} {w.connected ? '(connected)' : '(offline)'}
              </option>
            ))}
          </Select>
          <Select label="Project" value={effectiveProject} onChange={(e) => setProjectId(e.target.value)}>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.key}
              </option>
            ))}
          </Select>
          <Select
            label="Runtime"
            value={runtime || role?.defaultModel.runtime || ''}
            onChange={(e) => setRuntime(e.target.value)}
          >
            {runtimeOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <TextInput
            label="Model"
            placeholder={role?.defaultModel.model}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <Select label="Effort" value={effort} onChange={(e) => setEffort(e.target.value)}>
            <option value="">
              Default{role?.defaultModel.effort ? ` (${role.defaultModel.effort})` : ''}
            </option>
            {['low', 'medium', 'high'].map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
        </div>
        <TextInput
          label="Skills"
          hint="Comma separated, optional"
          value={skills}
          onChange={(e) => setSkills(e.target.value)}
        />
        <div>
          <TextInput
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
            maxLength={60}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="name-suggestions">
            <span className="text-xs text-zinc-500">Suggestions:</span>
            {suggestions.data?.map((n) => (
              <button
                type="button"
                key={n}
                onClick={() => setName(n)}
                className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                {n}
              </button>
            ))}
            <button type="button" onClick={() => setNonce((n) => n + 1)} className="text-xs underline">
              More
            </button>
          </div>
        </div>
        <ErrorBox error={hire.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={hire.isPending || full}>
            Hire
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
