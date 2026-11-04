import type {
  AgentDraftDto,
  AgentDto,
  AgentHome,
  HrAgent,
  McpServerCandidateDto,
  ProjectDto,
  RoleDefinition,
} from '@aom/shared';
import { Dices, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useAgentHomes } from '../api/queries/agent-move.ts';
import { useAgents, useFire, usePauseAgent, useRerollFace, useRoles } from '../api/queries/agents.ts';
import { useMe } from '../api/queries/auth.ts';
import { useResetAgent } from '../api/queries/devops.ts';
import { useHrBoard } from '../api/queries/hr.ts';
import { useMcpServers } from '../api/queries/mcp.ts';
import { useHirablePacks } from '../api/queries/my-capabilities.ts';
import { useDepartments } from '../api/queries/org.ts';
import { useProjects } from '../api/queries/projects.ts';
import { useRunningShifts } from '../api/queries/shifts.ts';
import { useWorkstations } from '../api/queries/workstations.ts';
import { AgentMcpSection } from '../components/agents/AgentMcpSection.tsx';
import { AgentRoleFollow } from '../components/agents/AgentRoleFollow.tsx';
import { DescribeAgentDialog } from '../components/agents/DescribeAgent.tsx';
import { HireDialog } from '../components/agents/HireDialog.tsx';
import { MayDoButton } from '../components/agents/MayDo.tsx';
import { MentionPolicy } from '../components/agents/MentionPolicy.tsx';
import { MoveAllAgentsDialog } from '../components/agents/MoveAllAgentsDialog.tsx';
import { MoveAgentDialog } from '../components/agents/MoveAgentDialog.tsx';
import { PackProvenance } from '../components/agents/PackProvenance.tsx';
import { AllowedProjectsDialog, WorksOn } from '../components/agents/ProjectAccess.tsx';
import { PickPackToHire } from '../components/capabilities/PickPackToHire.tsx';
import { RoleOffers } from '../components/capabilities/RoleOffers.tsx';
import { FirstRunGallery } from '../components/capabilities/StarterGallery.tsx';
import { DelegateGrants } from '../components/delegation/DelegateGrants.tsx';
import { AgentAvatar } from '../components/Face.tsx';
import { AgentStats, WorkQualityPanel } from '../components/hr/AgentStats.tsx';
import { ChangeModelDialog, ChangeRoleDialog } from '../components/hr/ChangeDialogs.tsx';
import { RecommendationList, RoleUpdates } from '../components/hr/Recommendations.tsx';
import { SandboxWarning } from '../components/SandboxWarning.tsx';
import { ShiftClock, ShiftStopControls } from '../components/ShiftStop.tsx';
import { PlaybookGrants } from '../components/slash/PlaybookGrants.tsx';
import {
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
import { canMoveAgent } from '../lib/agentMove.ts';
import { money } from '../lib/money.ts';
import { useCanManageOrg } from '../lib/orgRole.ts';
import { agentWarning } from '../lib/sandbox.ts';

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
  const [packHireOpen, setPackHireOpen] = useState(false);
  // the older hire from a pack (a persona becomes a chat-only role) is for the person's private packs; organization packs go through Hire agent > From a pack
  const hasPrivatePacks = (useHirablePacks().data?.packs ?? []).some((p) => p.visibility === 'private');
  const [describeOpen, setDescribeOpen] = useState(false);
  /** A reviewed draft waiting for the hire dialog (from "Describe the agent you need" or the starter gallery). */
  const [draftHire, setDraftHire] = useState<AgentDraftDto | null>(null);
  const orgManager = useCanManageOrg();
  const [firing, setFiring] = useState<AgentDto | null>(null);
  const [rehoming, setRehoming] = useState<AgentDto | null>(null);
  const homes = useAgentHomes(true);
  const [movingAll, setMovingAll] = useState<AgentHome | null>(null);
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
  const canMove = (a: AgentDto) =>
    canMoveAgent({
      myId,
      orgRole: orgRole(a),
      managerUserId: a.managerUserId,
      roleKey: a.roleKey,
      isDevops: a.isDevops,
      status: a.status,
      unpaired: a.workstationState === 'unpaired',
    });
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
            <Button onClick={() => setDescribeOpen(true)} data-testid="describe-agent-open">
              Describe the agent you need
            </Button>
            {hasPrivatePacks && (
              <Button onClick={() => setPackHireOpen(true)} data-testid="hire-from-pack-open">
                Hire from a private pack
              </Button>
            )}
            <Button variant="primary" onClick={() => setHireOpen(true)}>
              Hire agent
            </Button>
          </>
        }
      />
      {orgManager && <RoleOffers />}
      <WorkstationsSection homes={homes.data ?? []} manager={orgManager} onMoveAll={setMovingAll} />
      <FirstRunGallery />
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
      {board.data && (
        <RecommendationList
          recommendations={board.data.recommendations}
          projectId={projectFilter || undefined}
        />
      )}
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
              station={h.agent.workstationName ?? stationName(h.agent.workstationId)}
              projects={projects.data ?? []}
              canManage={canManage(h.agent)}
              mcpCandidates={mcp.data ?? []}
              ownerView={orgRole(h.agent) === 'owner'}
              onProjects={() => setAllowing(h.agent)}
              onFire={() => setFiring(h.agent)}
              onRehome={() => setRehoming(h.agent)}
              canMove={canMove(h.agent)}
              onMoveAll={() => {
                const home = (homes.data ?? []).find((x) => x.id === h.agent.workstationId);
                if (home) setMovingAll(home);
              }}
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
      <DescribeAgentDialog
        open={describeOpen}
        onOpenChange={setDescribeOpen}
        projectId={projectFilter || undefined}
        onContinue={(d) => {
          setDescribeOpen(false);
          setDraftHire(d);
        }}
      />
      {draftHire && <HireDialog open onOpenChange={(o) => !o && setDraftHire(null)} draft={draftHire} />}
      {packHireOpen && <PickPackToHire onClose={() => setPackHireOpen(false)} />}
      <FireDialog agent={firing} onClose={() => setFiring(null)} />
      <MoveAllAgentsDialog
        key={movingAll?.id ?? 'none-all'}
        source={movingAll}
        onClose={() => setMovingAll(null)}
        onMoveOne={(id) => {
          const one = agents.data?.find((x) => x.id === id);
          setMovingAll(null);
          if (one) setRehoming(one);
        }}
      />
      <MoveAgentDialog key={rehoming?.id ?? 'none'} agent={rehoming} onClose={() => setRehoming(null)} />
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
  canMove,
  onMoveAll,
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
  canMove: boolean;
  /** Opens the bulk move for the agent's (offline or removed) workstation. */
  onMoveAll: () => void;
  onModel: () => void;
  onRole: () => void;
  onReset: () => void;
  resetting: boolean;
  onReroll: () => void;
  rerolling: boolean;
}) {
  const a = hr.agent;
  const isBuilder = a.roleKey === 'builder';
  const isCeo = a.roleKey === 'ceo';
  const pause = usePauseAgent();
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
          {a.pausedAt && (
            <Badge
              tone="amber"
              className="ml-1"
              data-testid="agent-paused"
              title={a.pauseReason ?? 'Takes no new work'}
            >
              {a.pausedByCeo ? 'Paused by the CEO' : 'Paused'}
            </Badge>
          )}
        </span>
      </div>
      <PackProvenance agent={a} />
      <p className="font-mono text-xs text-subtle" data-testid="agent-model">
        {a.runtime} · {a.model}
        {a.effort ? ` · ${a.effort}` : ''}
        {station && ` · ${station}`}
      </p>
      {(a.workstationState === 'offline' || a.workstationState === 'unpaired') && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="amber" data-testid="agent-workstation-state">
            {a.workstationState === 'unpaired' ? 'workstation unpaired' : 'workstation offline'}
          </Badge>
          {canMove && (
            <Button
              size="sm"
              className="min-h-11 w-full sm:min-h-0 sm:w-auto"
              onClick={onMoveAll}
            >
              Move all agents from this workstation
            </Button>
          )}
        </div>
      )}
      {a.workstationRemoved && (
        <p className="text-xs font-medium text-warning" data-testid="agent-workstation-removed">
          Workstation removed – needs a new workstation
        </p>
      )}
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
      <div>
        <MayDoButton agentId={a.id} agentName={a.name} />
      </div>
      {!a.isDevops && <PlaybookGrants agentId={a.id} />}
      {!a.isDevops && a.roleKey !== 'ceo' && <MentionPolicy agentId={a.id} canManage={canManage} />}
      {!a.isDevops && a.roleKey !== 'ceo' && <DelegateGrants ownerKind="agent" ownerId={a.id} />}
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
          {canMove && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Move ${a.name} to another workstation`}
              onClick={onRehome}
            >
              Move to workstation
            </Button>
          )}
        </div>
      ) : canManage && isCeo ? (
        <div className="mt-auto flex flex-wrap items-center gap-1 border-t border-line pt-3">
          <Button
            variant="ghost"
            size="sm"
            loading={pause.isPending}
            aria-label={`${a.pausedAt ? 'Resume' : 'Pause'} ${a.name}`}
            onClick={() => pause.mutate({ id: a.id, pause: !a.pausedAt })}
          >
            {a.pausedAt ? 'Resume' : 'Pause'}
          </Button>
          <Link to="/org/ceo" className="ml-auto text-sm font-medium text-brand-text hover:underline">
            Manage on the CEO page
          </Link>
        </div>
      ) : canManage ? (
        <div className="mt-auto flex flex-wrap items-center gap-1 border-t border-line pt-3">
          {canMove && a.status === 'needs_rehome' && (
            <Button variant="primary" size="sm" aria-label={`Re-home ${a.name}`} onClick={onRehome}>
              Re-home
            </Button>
          )}
          {canMove && a.status !== 'needs_rehome' && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Move ${a.name} to another workstation`}
              onClick={onRehome}
            >
              Move to workstation
            </Button>
          )}
          <Button variant="ghost" size="sm" aria-label={`Allowed projects of ${a.name}`} onClick={onProjects}>
            Projects
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={pause.isPending}
            aria-label={`${a.pausedAt ? 'Resume' : 'Pause'} ${a.name}`}
            onClick={() => pause.mutate({ id: a.id, pause: !a.pausedAt })}
          >
            {a.pausedAt ? 'Resume' : 'Pause'}
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

/** Owner/Admin: where the organization's agents live, with a bulk move off a workstation (dead, offline or live). */
function WorkstationsSection({
  homes,
  manager,
  onMoveAll,
}: {
  homes: AgentHome[];
  /** Owner or Admin: sees every workstation; anyone else only the offline or removed ones that hold their agents. */
  manager: boolean;
  onMoveAll: (h: AgentHome) => void;
}) {
  const dead = (h: AgentHome) => h.status !== 'active' || !h.connected;
  const shown = homes.filter((h) => h.agentCount > 0 && (manager || dead(h)));
  if (shown.length === 0) return null;
  const attention = shown.some((h) => h.status !== 'active' || !h.connected);
  return (
    <Disclosure className="mb-4" summary={`Workstations (${shown.length})`} defaultOpen={attention}>
      <ul className="flex flex-col gap-2" data-testid="agent-homes">
        {shown.map((h) => (
          <li
            key={h.id}
            className="flex flex-col gap-2 rounded-md border border-line p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{h.name}</span>
              <Badge tone={h.status !== 'active' ? 'danger' : h.connected ? 'success' : 'warning'}>
                {h.status !== 'active' ? 'Unpaired' : h.connected ? 'Online' : 'Offline'}
              </Badge>
              <span className="text-subtle">
                {h.agentCount} {h.agentCount === 1 ? 'agent' : 'agents'}
                {h.mine ? '' : ` · ${h.ownerName}`}
              </span>
            </div>
            <Button
              className="min-h-11 w-full sm:w-auto"
              aria-label={`Move all agents from ${h.name}`}
              onClick={() => onMoveAll(h)}
            >
              {dead(h) ? 'Move all agents from this workstation' : 'Move all agents'}
            </Button>
          </li>
        ))}
      </ul>
    </Disclosure>
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
