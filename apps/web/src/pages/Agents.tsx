import {
  type AgentDto,
  type HrAgent,
  type McpServerCandidateDto,
  NAME_THEMES,
  type ProjectDto,
  type RoleDefinition,
} from '@aom/shared';
import { Dices, Users } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import {
  useAgents,
  useFire,
  useHire,
  useNameSuggestions,
  useRerollFace,
  useRoles,
} from '../api/queries/agents.ts';
import { useMe } from '../api/queries/auth.ts';
import { useResetAgent } from '../api/queries/devops.ts';
import { useHrBoard } from '../api/queries/hr.ts';
import { useMcpServers } from '../api/queries/mcp.ts';
import { useRehomeAgent } from '../api/queries/members.ts';
import { useDepartments } from '../api/queries/org.ts';
import { useProjects } from '../api/queries/projects.ts';
import { useRunningShifts } from '../api/queries/shifts.ts';
import { useWorkstations } from '../api/queries/workstations.ts';
import { AgentMcpSection } from '../components/agents/AgentMcpSection.tsx';
import { AgentRoleFollow } from '../components/agents/AgentRoleFollow.tsx';
import {
  type Access,
  AllowedProjectsDialog,
  ProjectAccessEditor,
  WorksOn,
} from '../components/agents/ProjectAccess.tsx';
import { AgentAvatar } from '../components/Face.tsx';
import { AgentStats, WorkQualityPanel } from '../components/hr/AgentStats.tsx';
import { ChangeModelDialog, ChangeRoleDialog } from '../components/hr/ChangeDialogs.tsx';
import { RecommendationList, RoleUpdates } from '../components/hr/Recommendations.tsx';
import { SandboxWarning } from '../components/SandboxWarning.tsx';
import { ShiftClock, ShiftStopControls } from '../components/ShiftStop.tsx';
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  Select,
  TextInput,
  useToast,
} from '../components/ui.tsx';
import { getLastProjectKey } from '../lib/lastProject.ts';
import { money } from '../lib/money.ts';
import { agentWarning, isRuntimeUnsandboxed, sandboxReasonOf } from '../lib/sandbox.ts';

/**
 * The HR board (docs/SPEC.md "HR board"): one card per agent with avatar, role, model, status, hiring manager, stats
 * against the role average, a work-quality panel for builders, and the recommendations with evidence and one-click apply.
 */
export function Agents() {
  const [projectFilter, setProjectFilter] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const board = useHrBoard(projectFilter || undefined, departmentFilter || undefined);
  const orgCatalogue = useDepartments();
  const agents = useAgents();
  const roles = useRoles();
  const workstations = useWorkstations();
  const [params] = useSearchParams();
  /** `/agents?hire=tester&projectId=<id>` (the desk's "Hire tester" button) opens the form prefilled. */
  const [prefill] = useState(() => {
    const role = params.get('hire');
    return role
      ? {
          roleKey: role,
          projectId: params.get('projectId') ?? '',
          seniority: params.get('seniority') ?? '',
        }
      : null;
  });
  const [hireOpen, setHireOpen] = useState(!!prefill);
  const [firing, setFiring] = useState<AgentDto | null>(null);
  const [rehoming, setRehoming] = useState<AgentDto | null>(null);
  const [changingModel, setChangingModel] = useState<AgentDto | null>(null);
  const [changingRole, setChangingRole] = useState<AgentDto | null>(null);
  const [allowing, setAllowing] = useState<AgentDto | null>(null);
  const me = useMe();
  const projects = useProjects();
  const reset = useResetAgent();
  const mcp = useMcpServers();
  const reroll = useRerollFace();
  const myId = me.data?.user.id;
  const { hash } = useLocation();
  // The command palette links to /agents#<id>: bring that agent into view once the board has loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run when the board or the hash changes
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView?.({ block: 'center' });
  }, [hash, board.data]);
  /** The org owner may change and fire any agent; a member only the ones they hired themselves. */
  // The organization's Owner and Admins manage any of its agents; everyone else the agents they hired.
  const orgRole = (a: AgentDto) => me.data?.orgs?.find((o) => o.id === a.orgId)?.role;
  const canManage = (a: AgentDto) =>
    !!myId && (orgRole(a) === 'owner' || orgRole(a) === 'admin' || myId === a.managerUserId);
  const roleName = (k: string) => roles.data?.find((r) => r.definition.key === k)?.definition.name ?? k;
  const stationName = (id: string | null) => workstations.data?.find((w) => w.id === id)?.name ?? '';
  const active = board.data?.agents ?? [];
  const retired = agents.data?.filter((a) => a.status === 'retired') ?? [];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Agents"
        sub={`Performance over the last ${board.data?.windowDays ?? 30} days, each against the average of the agents in the role.`}
        actions={
          <>
            <ButtonLink to="/metrics" data-testid="metrics-link">
              Metrics
            </ButtonLink>
            <Button variant="primary" onClick={() => setHireOpen(true)}>
              Hire agent
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-3">
        {(projects.data?.length ?? 0) > 1 && (
          <div className="w-full max-w-xs">
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
        {(orgCatalogue.data?.length ?? 0) > 0 && (
          <div className="w-full max-w-xs">
            <Select
              label="Department"
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
            >
              <option value="">All departments</option>
              {orgCatalogue.data?.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      {board.isPending && <ListSkeleton label="Loading agents" />}
      {board.isError && <ErrorBox error={board.error} onRetry={() => board.refetch()} />}
      <ErrorBox error={reset.error ?? reroll.error} />
      {board.data && <RoleUpdates updates={board.data.roleUpdates} />}
      {board.data && <RecommendationList recommendations={board.data.recommendations} />}
      {board.data && active.length === 0 && (
        <EmptyState
          icon={Users}
          title="No agents yet"
          description="No agents hired yet. Hire a builder and a reviewer to start moving cards."
          action={
            <Button variant="primary" onClick={() => setHireOpen(true)}>
              Hire agent
            </Button>
          }
        />
      )}
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="agents">
        {active.map((h) => (
          <li
            key={h.agent.id}
            id={h.agent.id}
            className="scroll-mt-20 target:[&>*]:ring-2 target:[&>*]:ring-ring/60"
            data-testid={`agent-${h.agent.name}`}
            data-editable={canManage(h.agent) ? 'true' : 'false'}
          >
            <AgentCard
              hr={h}
              roleName={roleName(h.agent.roleKey)}
              role={roles.data?.find((r) => r.definition.key === h.agent.roleKey)?.definition}
              station={stationName(h.agent.workstationId)}
              projects={projects.data ?? []}
              canManage={canManage(h.agent)}
              mcpCandidates={mcp.data ?? []}
              ownerView={orgRole(h.agent) === 'owner'}
              onProjects={() => setAllowing(h.agent)}
              onFire={() => setFiring(h.agent)}
              onRehome={() => setRehoming(h.agent)}
              onModel={() => setChangingModel(h.agent)}
              onRole={() => setChangingRole(h.agent)}
              onReset={() => reset.mutate(h.agent.id)}
              resetting={reset.isPending}
              onReroll={() => reroll.mutate(h.agent.id)}
              rerolling={reroll.isPending}
            />
          </li>
        ))}
      </ul>
      {retired.length > 0 && (
        <Disclosure className="mt-6" summary={`Retired (${retired.length})`}>
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {retired.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm text-muted">
                <AgentAvatar agentId={a.id} name={a.name} size={22} />
                <span className="font-medium text-fg">{a.name}</span>
                <span>{roleName(a.roleKey)}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      <HireDialog open={hireOpen} onOpenChange={setHireOpen} prefill={prefill} />
      <FireDialog agent={firing} onClose={() => setFiring(null)} />
      <RehomeDialog agent={rehoming} onClose={() => setRehoming(null)} />
      <AllowedProjectsDialog
        agent={allowing}
        projects={projects.data ?? []}
        canAny={!!allowing && ['owner', 'admin'].includes(orgRole(allowing) ?? '')}
        onClose={() => setAllowing(null)}
      />
      <ChangeModelDialog agent={changingModel} onClose={() => setChangingModel(null)} />
      <ChangeRoleDialog agent={changingRole} roles={roles.data ?? []} onClose={() => setChangingRole(null)} />
    </div>
  );
}

/** The shift the agent is running now: how long, how long it has been quiet, and the stop controls. */
function AgentRunningShift({ agentId, canStop }: { agentId: string; canStop: boolean }) {
  const running = useRunningShifts();
  const shift = running.data?.find((s) => s.agentId === agentId && s.status !== 'ended');
  if (!shift) return null;
  return (
    <div
      className="flex flex-col gap-2 rounded-control border border-line px-3 py-2"
      data-testid="agent-running-shift"
    >
      <ShiftClock shift={shift} />
      {canStop && <ShiftStopControls shift={shift} />}
    </div>
  );
}

function AgentCard({
  hr,
  roleName,
  role,
  station,
  projects,
  canManage,
  mcpCandidates,
  ownerView,
  onProjects,
  onFire,
  onRehome,
  onModel,
  onRole,
  onReset,
  resetting,
  onReroll,
  rerolling,
}: {
  hr: HrAgent;
  roleName: string;
  role: RoleDefinition | undefined;
  station: string;
  projects: ProjectDto[];
  canManage: boolean;
  mcpCandidates: McpServerCandidateDto[];
  /** The viewer is the Owner of the agent's organization: the only one who changes its external tools. */
  ownerView: boolean;
  onProjects: () => void;
  onFire: () => void;
  onRehome: () => void;
  onModel: () => void;
  onRole: () => void;
  onReset: () => void;
  resetting: boolean;
  onReroll: () => void;
  rerolling: boolean;
}) {
  const a = hr.agent;
  const isBuilder = a.roleKey === 'builder';
  return (
    <Panel className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          className={`rounded-full p-0.5 ring-2 ring-offset-2 ring-offset-surface ${
            a.status === 'needs_rehome'
              ? 'ring-warning-fill'
              : a.activeCards.length
                ? 'ring-accent'
                : hr.blockedOn.length
                  ? 'ring-danger-fill'
                  : 'ring-line'
          }`}
        >
          <span className="group/face relative inline-flex">
            <AgentAvatar
              agentId={a.id}
              name={a.name}
              size={40}
              {...(a.avatarSeed ? { seed: a.avatarSeed } : {})}
              {...(a.avatarStyle ? { style: a.avatarStyle } : {})}
            />
            {canManage && (
              <button
                type="button"
                aria-label={`Re-roll the face of ${a.name}`}
                title="Re-roll face"
                disabled={rerolling}
                onClick={onReroll}
                className="absolute -right-1.5 -bottom-1.5 inline-flex size-5 items-center justify-center rounded-full border border-line bg-surface text-muted opacity-70 shadow-sm transition-opacity group-hover/face:opacity-100 hover:text-fg focus-visible:opacity-100 disabled:opacity-40 [@media(pointer:coarse)]:opacity-100"
              >
                <Dices aria-hidden="true" className="size-3" />
              </button>
            )}
          </span>
        </span>
        <div className="min-w-0">
          <p className="truncate text-lg leading-tight font-semibold text-fg">{a.name}</p>
          <p className="text-sm text-muted">
            {roleName} · {a.seniority}
          </p>
        </div>
        <span className="ml-auto" data-testid="agent-status">
          {a.status === 'needs_rehome' ? (
            <Badge tone="amber">needs rehome</Badge>
          ) : a.activeCards.length ? (
            <Badge tone="blue">on shift</Badge>
          ) : hr.blockedOn.length ? (
            <Badge tone="red" title="Left a card blocked on a question for the manager">
              blocked
            </Badge>
          ) : (
            <Badge>idle</Badge>
          )}
        </span>
      </div>
      <p className="font-mono text-xs text-subtle" data-testid="agent-model">
        {a.runtime} · {a.model}
        {a.effort ? ` · ${a.effort}` : ''}
        {station && ` · ${station}`}
      </p>
      {a.sandbox === 'unsandboxed' && (
        <SandboxWarning testId="agent-sandbox-warning" lead="Warning:">
          {agentWarning(station || 'its workstation', a.sandboxReason)}
        </SandboxWarning>
      )}
      <WorksOn agent={a} projects={projects} />
      <p className="text-xs text-subtle" data-testid="agent-hired-by">
        Hired by {hr.hiredByName}
      </p>
      {hr.spend && (
        <p className="tnum text-xs text-subtle" data-testid="agent-spend">
          Cost: {money(hr.spend.monthMicros, hr.spend.currency)} this month,{' '}
          {money(hr.spend.totalMicros, hr.spend.currency)} in total
        </p>
      )}
      <p className="rounded-control bg-sunken px-3 py-2 text-sm text-muted" data-testid="agent-current-card">
        {a.activeCards.length === 0
          ? hr.blockedOn.length
            ? hr.blockedOn.map((c) => (
                <Link
                  key={c.cardId}
                  to={`/cards/${c.cardId}`}
                  className="font-medium text-brand-text hover:underline"
                >
                  {c.ref} {c.title} (blocked)
                </Link>
              ))
            : 'No current card'
          : a.activeCards.map((c) => (
              <Link
                key={c.cardId}
                to={`/cards/${c.cardId}`}
                className="font-medium text-brand-text hover:underline"
              >
                {c.ref} {c.title}
              </Link>
            ))}
      </p>
      <AgentRunningShift agentId={a.id} canStop={canManage} />
      <AgentRoleFollow agent={a} role={role} />
      {!a.isDevops && <AgentStats stats={hr.stats} roleName={roleName.toLowerCase()} />}
      {isBuilder && <WorkQualityPanel quality={hr.quality} />}
      {!a.isDevops && (
        <AgentMcpSection
          agent={a}
          candidates={mcpCandidates}
          canEdit={ownerView}
          {...(a.allowedProjectIds?.[0]
            ? { projectSettingsTo: `/projects/${a.allowedProjectIds[0]}/settings#mcp-servers` }
            : {})}
        />
      )}
      {a.isDevops ? (
        <div className="mt-auto flex items-center gap-2">
          <Badge tone="violet">DevOps engineer</Badge>
          {canManage && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Reset ${a.name}`}
              disabled={resetting}
              onClick={onReset}
            >
              Reset
            </Button>
          )}
        </div>
      ) : canManage ? (
        <div className="mt-auto flex flex-wrap items-center gap-1 border-t border-line pt-3">
          {a.status === 'needs_rehome' && (
            <Button variant="primary" size="sm" aria-label={`Re-home ${a.name}`} onClick={onRehome}>
              Re-home
            </Button>
          )}
          <Button variant="ghost" size="sm" aria-label={`Allowed projects of ${a.name}`} onClick={onProjects}>
            Projects
          </Button>
          <Button variant="ghost" size="sm" aria-label={`Change model of ${a.name}`} onClick={onModel}>
            Change model
          </Button>
          <Button variant="ghost" size="sm" aria-label={`Change role of ${a.name}`} onClick={onRole}>
            Change role
          </Button>
          <Button
            variant="danger-ghost"
            size="sm"
            className="ml-auto"
            aria-label={`Fire ${a.name}`}
            onClick={onFire}
          >
            Fire
          </Button>
        </div>
      ) : (
        <p className="mt-auto text-xs text-subtle" data-testid="agent-readonly">
          Hired by another manager (read only)
        </p>
      )}
    </Panel>
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
  const rehomeUnsandboxed = !!station && isRuntimeUnsandboxed(station.runtimes, effRuntime);
  const [rehomeAck, setRehomeAck] = useState(false);
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
                ...(rehomeUnsandboxed && rehomeAck ? { acknowledgeUnsandboxed: true } : {}),
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
          {rehomeUnsandboxed && station && (
            <div className="flex flex-col gap-2">
              <SandboxWarning testId="rehome-sandbox-warning" role="alert" lead="Warning:">
                {agentWarning(station.name, sandboxReasonOf(station.runtimes, effRuntime))}
              </SandboxWarning>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={rehomeAck}
                  onChange={(e) => setRehomeAck(e.target.checked)}
                  className="mt-1"
                />
                <span>I understand this agent runs without an OS sandbox on {station.name}</span>
              </label>
            </div>
          )}
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
  const toast = useToast();
  return (
    <Dialog
      open={!!agent}
      onOpenChange={(o) => !o && onClose()}
      title={`Fire ${agent?.name ?? ''}?`}
      description="The agent is retired, its sandbox is wiped and its record is kept. Its name is never reused."
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
            <p className="text-sm text-subtle" data-testid="fire-releases">
              This agent holds no cards. Nothing will be released.
            </p>
          )}
          <ErrorBox error={fire.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="danger"
              disabled={fire.isPending}
              onClick={() =>
                fire.mutate(agent.id, {
                  onSuccess: () => {
                    toast.success(`${agent.name} was fired`);
                    onClose();
                  },
                })
              }
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
  prefill,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  prefill?: { roleKey: string; projectId: string; seniority?: string } | null;
}) {
  const stations = useWorkstations();
  const projects = useProjects();
  const hire = useHire();
  const [nonce, setNonce] = useState(0);
  const [theme, setTheme] = useState('default');
  const suggestions = useNameSuggestions(open, nonce, theme);
  const [roleKey, setRoleKey] = useState(prefill?.roleKey ?? '');
  const [seniority, setSeniority] = useState(prefill ? prefill.seniority || 'junior' : '');
  const [workstationId, setWorkstationId] = useState('');
  const me = useMe();
  const activeOrg = me.data?.activeOrg ?? null;
  const canAny = activeOrg?.role === 'owner' || activeOrg?.role === 'admin';
  /** What the manager picked in "Where may this agent work?"; untouched, the default below applies. */
  const [access, setAccess] = useState<Access | null>(null);
  // The default for a new hire: the project the form was opened for, else the one worked on last. "Any project" is a
  // deliberate choice of the organization's Owner and Admins.
  const defaultProject =
    (prefill?.projectId && projects.data?.find((p) => p.id === prefill.projectId)?.id) ||
    projects.data?.find((p) => p.key === getLastProjectKey())?.id ||
    projects.data?.find((p) => p.orgId === activeOrg?.id)?.id ||
    projects.data?.[0]?.id ||
    '';
  // With no project to pick yet (a new organization) the agent may work any project it gets later.
  const effectiveAccess: Access = access ?? { allowed: defaultProject ? [defaultProject] : null, focus: [] };
  // A shared project runs on its owner's catalogue: the Hire form lists that organization's roles (custom ones too).
  const roles = useRoles(effectiveAccess.allowed?.[0] || defaultProject || undefined);
  const [runtime, setRuntime] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [skills, setSkills] = useState('');
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** The workstation+runtime the unsandboxed confirmation was given for: choosing another asks again. */
  const [ackedFor, setAckedFor] = useState('');

  const hireable = useMemo(
    () => (roles.data ?? []).filter((r) => r.definition.key !== 'devops'),
    [roles.data],
  );
  const activeStations = (stations.data ?? []).filter((w) => w.status === 'active');
  const effectiveRoleKey = roleKey || hireable[0]?.definition.key || '';
  const role = hireable.find((r) => r.definition.key === effectiveRoleKey)?.definition;
  const effectiveSeniority =
    seniority && role?.seniorityLevels.includes(seniority as 'junior')
      ? seniority
      : (role?.seniorityLevels[0] ?? '');
  const effectiveStation = workstationId || activeStations[0]?.id || '';
  const station = activeStations.find((w) => w.id === effectiveStation);
  const runtimeOptions = [
    ...new Set(
      [
        role?.defaultModel.runtime,
        ...(station?.runtimes.filter((r) => r.available).map((r) => r.id) ?? []),
      ].filter(Boolean) as string[],
    ),
  ];

  const effectiveRuntime = runtime || role?.defaultModel.runtime || '';
  const unsandboxed = !!station && isRuntimeUnsandboxed(station.runtimes, effectiveRuntime);
  const ackKey = `${effectiveStation}:${effectiveRuntime}`;
  const ackUnsandboxed = ackedFor === ackKey;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!role) errs.role = 'Choose a role';
    if (unsandboxed && !ackUnsandboxed)
      errs.sandbox = 'Confirm that you accept hiring onto an unsandboxed workstation';
    if (!name.trim()) errs.name = 'A name is required';
    if (effectiveAccess.allowed !== null && effectiveAccess.allowed.length === 0)
      errs.access = 'Pick at least one project, or allow any project';
    if (!effectiveStation) errs.workstation = 'Pair a workstation first';
    setErrors(errs);
    if (Object.keys(errs).length || !role) return;
    hire.mutate(
      {
        name: name.trim(),
        roleKey: role.key,
        seniority: effectiveSeniority as 'junior' | 'senior',
        workstationId: effectiveStation,
        allowedProjectIds: effectiveAccess.allowed,
        ...(effectiveAccess.focus.length ? { focusProjectIds: effectiveAccess.focus } : {}),
        ...(runtime ? { runtime } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(effort ? { effort } : {}),
        ...(unsandboxed && ackUnsandboxed ? { acknowledgeUnsandboxed: true } : {}),
        skills: skills
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        capacity: 1,
      },
      {
        onSuccess: () => {
          setName('');
          setAccess(null);
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
          hint={role?.department ? `Department: ${role.department}` : undefined}
        >
          {hireable.map((r) => (
            <option key={r.definition.key} value={r.definition.key}>
              {r.definition.name}
            </option>
          ))}
        </Select>
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
        <div>
          <ProjectAccessEditor
            value={effectiveAccess}
            onChange={setAccess}
            projects={projects.data ?? []}
            canAny={canAny}
            idPrefix="hire"
          />
          {errors.access && (
            <p role="alert" className="mt-1 text-sm font-medium text-danger">
              {errors.access}
            </p>
          )}
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
            <select
              aria-label="Name theme"
              data-testid="name-theme"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              className="rounded border border-control bg-surface px-1 py-0.5 text-xs"
            >
              {NAME_THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-subtle">Suggestions:</span>
            {suggestions.data?.map((n) => (
              <button
                type="button"
                key={n}
                onClick={() => setName(n)}
                className="rounded-full border border-control px-2 py-0.5 text-xs hover:bg-sunken"
              >
                {n}
              </button>
            ))}
            <button type="button" onClick={() => setNonce((n) => n + 1)} className="text-xs underline">
              More
            </button>
          </div>
        </div>
        {unsandboxed && station && (
          <div className="flex flex-col gap-2" data-testid="hire-unsandboxed">
            <SandboxWarning testId="hire-sandbox-warning" role="alert" lead="Warning:">
              {agentWarning(station.name, sandboxReasonOf(station.runtimes, effectiveRuntime))}
            </SandboxWarning>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={ackUnsandboxed}
                onChange={(e) => setAckedFor(e.target.checked ? ackKey : '')}
                aria-describedby={errors.sandbox ? 'hire-sandbox-error' : undefined}
                className="mt-1"
              />
              <span>I understand this agent runs without an OS sandbox on {station.name}</span>
            </label>
            {errors.sandbox && (
              <p id="hire-sandbox-error" role="alert" className="text-sm text-danger">
                {errors.sandbox}
              </p>
            )}
          </div>
        )}
        <ErrorBox error={hire.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={hire.isPending}>
            Hire
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
