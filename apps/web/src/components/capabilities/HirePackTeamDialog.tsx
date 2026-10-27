import {
  type HirePackAgentsRequest,
  type HirePackAgentsResponse,
  modelChoicesFor,
  type PackSeat,
  type PackTeamResponse,
} from '@aom/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useRoles } from '../../api/queries/agents.ts';
import { useMe } from '../../api/queries/auth.ts';
import { usePacks } from '../../api/queries/capabilities.ts';
import { useOrg } from '../../api/queries/orgs.ts';
import { packHireMessage, useHirePackTeam, usePackTeam } from '../../api/queries/pack-team.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import { agentWarning, isRuntimeUnsandboxed, sandboxReasonOf } from '../../lib/sandbox.ts';
import { type Access, ProjectAccessEditor } from '../agents/ProjectAccess.tsx';
import { unionExtras } from '../ModelSelect.tsx';
import { SandboxWarning } from '../SandboxWarning.tsx';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  ErrorBox,
  ListSkeleton,
  Select,
  TextInput,
  useToast,
} from '../ui.tsx';

type TeamAgent = PackTeamResponse['agents'][number];

/** Over this many ticked agents the person confirms the number before the hire button works. */
export const BIG_HIRE = 10;
/** The server takes at most 60 items per hire. */
const MAX_ITEMS = 60;
const PAGE = 50;

interface Row {
  on: boolean;
  seat: PackSeat;
  count: number;
  /** Typed name; empty means the pack agent's own name (the server makes it unique). */
  name: string;
  seniority: string;
  model: string;
  /** Ticked skills of the agent's `skillRefs`; null: all of them. */
  skills: string[] | null;
}

const OWN = 'own';

/** The numbering the server gives a count above one: "Mary, Mary 2, Mary 3". */
export const numbering = (name: string, count: number): string =>
  Array.from({ length: Math.min(count, 5) }, (_, i) => (i === 0 ? name : `${name} ${i + 1}`)).join(', ');

/**
 * Hire the whole pack (Owner and Admin): a review table of the pack's agents. Nothing is hired that is not ticked, a pack of
 * many agents starts with none ticked, and the total is shown before anything is sent. One workstation takes the whole batch.
 */
export function HirePackTeamDialog({
  packId,
  packName,
  onClose,
}: {
  packId: string;
  packName: string;
  onClose: () => void;
}) {
  const team = usePackTeam(packId);
  const roles = useRoles();
  const stations = useWorkstations();
  const packs = usePacks();
  const projects = useProjects();
  const me = useMe();
  const org = useOrg();
  const hire = useHirePackTeam(packId);
  const toast = useToast();
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [initFor, setInitFor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [workstationId, setWorkstationId] = useState('');
  const [runtime, setRuntime] = useState('');
  const [access, setAccess] = useState<Access | null>(null);
  const [ackedFor, setAckedFor] = useState('');
  const [serverWantsAck, setServerWantsAck] = useState(false);
  const [confirmBig, setConfirmBig] = useState(false);
  const [done, setDone] = useState<HirePackAgentsResponse | null>(null);

  const agents = team.data?.agents ?? [];
  const seatName = useMemo(
    () => new Map((team.data?.seats ?? []).map((s) => [s.key as string, s.name])),
    [team.data],
  );
  const roleOf = (seat: string) => roles.data?.find((r) => r.definition.key === seat)?.definition;

  // The first load: every agent gets its suggested seat. Ticked by default: those with a seat of their own kind, unless
  // that would be many (a pack of 200 agents is never hired by accident): then nothing is ticked and the person picks.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the pack's team arrives
  useEffect(() => {
    if (!team.data || initFor === packId) return;
    const suggested = team.data.agents.filter((a) => a.suggestedSeat !== OWN).length;
    const preTick = suggested <= BIG_HIRE;
    setRows(
      Object.fromEntries(
        team.data.agents.map((a) => [
          a.key,
          {
            on: preTick && a.suggestedSeat !== OWN,
            seat: a.suggestedSeat,
            count: 1,
            name: '',
            seniority: '',
            model: '',
            skills: null,
          } satisfies Row,
        ]),
      ),
    );
    setInitFor(packId);
  }, [team.data]);

  const isManager = me.data?.activeOrg?.role === 'owner' || me.data?.activeOrg?.role === 'admin';
  const pack = packs.data?.packs.find((p) => p.id === packId);
  const mine = (stations.data ?? []).filter((w) => w.userId === me.data?.user?.id && w.status === 'active');
  const holding = mine.filter((w) =>
    pack?.holders.some((h) => h.workstationId === w.id && h.assignment === 'accepted'),
  );
  // the workstations that hold the pack; if the page cannot tell (an authored pack), all of the caller's own
  const choices = holding.length ? holding : mine;
  const station = choices.find((w) => w.id === (workstationId || choices[0]?.id));
  const defaultProject =
    projects.data?.find((p) => p.orgId === me.data?.activeOrg?.id)?.id ?? projects.data?.[0]?.id;
  const effectiveAccess: Access = access ?? { allowed: defaultProject ? [defaultProject] : null, focus: [] };

  const rowOf = (a: TeamAgent): Row =>
    rows[a.key] ?? {
      on: false,
      seat: a.suggestedSeat,
      count: 1,
      name: '',
      seniority: '',
      model: '',
      skills: null,
    };
  const patch = (key: string, p: Partial<Row>) =>
    setRows((cur) => ({ ...cur, [key]: { ...(cur[key] as Row), ...p } }));

  const ticked = agents.filter((a) => rowOf(a).on);
  const total = ticked.reduce((n, a) => n + rowOf(a).count, 0);
  const needle = search.trim().toLowerCase();
  const visible = agents.filter(
    (a) => !needle || `${a.key} ${a.name} ${a.description}`.toLowerCase().includes(needle),
  );

  const runtimeOptions = [
    ...new Set(
      (station?.runtimes ?? []).filter((r) => r.available && r.id !== 'direct-model').map((r) => r.id),
    ),
  ];
  // Without a chosen runtime each agent runs on its seat's default runtime.
  const effectiveRuntimes = runtime
    ? [runtime]
    : [...new Set(ticked.map((a) => roleOf(rowOf(a).seat)?.defaultModel.runtime ?? 'claude-code'))];
  const unsandboxed = !!station && effectiveRuntimes.some((r) => isRuntimeUnsandboxed(station.runtimes, r));
  const unsandboxedRuntime =
    effectiveRuntimes.find((r) => !!station && isRuntimeUnsandboxed(station.runtimes, r)) ?? '';
  const needsAck = unsandboxed || serverWantsAck;
  const ackKey = `${station?.id}:${effectiveRuntimes.join(',')}`;
  const acked = ackedFor === ackKey;
  const modelSuggestions = modelChoicesFor(
    effectiveRuntimes,
    [],
    unionExtras(station ? [station] : []),
  ).flatMap((g) => g.models.map((m) => m.id));

  const limit = org.data?.limits?.maxAgents ?? null;
  const used = org.data?.usage?.agents ?? null;
  const overLimit = limit !== null && used !== null && used + total > limit;
  const accessOk = effectiveAccess.allowed === null || effectiveAccess.allowed.length > 0;
  const big = total > BIG_HIRE;
  const ready =
    ticked.length > 0 &&
    ticked.length <= MAX_ITEMS &&
    !!station &&
    accessOk &&
    !overLimit &&
    (!needsAck || acked) &&
    (!big || confirmBig);

  const setAll = (pick: (a: TeamAgent) => boolean) =>
    setRows((cur) =>
      Object.fromEntries(agents.map((a) => [a.key, { ...(cur[a.key] ?? rowOf(a)), on: pick(a) }])),
    );

  const submit = () => {
    if (!station) return;
    const items: HirePackAgentsRequest['items'] = ticked.map((a) => {
      const r = rowOf(a);
      return {
        key: a.key,
        seat: r.seat,
        count: r.count,
        ...(r.name.trim() ? { name: r.name.trim() } : {}),
        ...(r.seniority ? { seniority: r.seniority as 'junior' | 'senior' } : {}),
        ...(r.model.trim() ? { model: r.model.trim() } : {}),
        ...(r.skills ? { skills: r.skills } : {}),
      };
    });
    hire.mutate(
      {
        items,
        workstationId: station.id,
        capacity: 1,
        ...(runtime ? { runtime } : {}),
        allowedProjectIds: effectiveAccess.allowed,
        ...(needsAck && acked ? { acknowledgeUnsandboxed: true } : {}),
      },
      {
        onSuccess: (r) => {
          setDone(r);
          toast.success(
            `${r.agents.length} agent${r.agents.length === 1 ? '' : 's'} hired from ${packName}.`,
          );
        },
        onError: (e) => {
          if ((e as { code?: string }).code === 'unsandboxed_ack_required') setServerWantsAck(true);
        },
      },
    );
  };

  if (done)
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={`Hired from ${packName}`}
        description="They joined the agents you already have."
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Link
              to="/agents"
              onClick={onClose}
              className="inline-flex min-h-9 items-center rounded-control bg-brand px-3 text-sm font-medium text-brand-fg"
              data-testid="to-agents"
            >
              Go to Agents
            </Link>
          </>
        }
      >
        <ul className="flex flex-col gap-1 text-sm" data-testid="hired-list">
          {done.agents.map((a) => (
            <li key={a.agentId}>
              <strong>{a.name}</strong>{' '}
              <span className="text-muted">
                as {a.seat === OWN ? 'its own role' : (seatName.get(a.seat) ?? a.seat)}
              </span>
            </li>
          ))}
        </ul>
      </Dialog>
    );

  const err = hire.error;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Hire from ${packName}`}
      description="Tick the pack agents to hire, give each a seat, and review what you add before you confirm."
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={hire.isPending}
            onClick={submit}
            data-testid="confirm-team-hire"
          >
            {total === 0 ? 'Hire' : `Hire ${total} agent${total === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="hire-team-dialog">
        {!isManager && (
          <Callout tone="warning">
            Only an Owner or Admin hires a whole pack. Hire one agent from Agents instead.
          </Callout>
        )}
        {(team.isPending || roles.isPending) && <ListSkeleton label="Loading the pack's agents" rows={3} />}
        {team.isError && <ErrorBox error={team.error} onRetry={() => team.refetch()} />}
        {team.data && agents.length === 0 && (
          <p className="text-sm text-muted">
            This pack has no agents yet. Mark skills as agents in its Team section, or add a pack with
            personas.
          </p>
        )}
        {agents.length > 0 && (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1">
                <TextInput
                  label="Search agents"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setShown(PAGE);
                  }}
                  data-testid="team-hire-search"
                />
              </div>
              <Button
                size="sm"
                onClick={() => setAll((a) => a.suggestedSeat !== OWN)}
                data-testid="tick-suggested"
              >
                Tick the ones with a seat
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAll(() => false)} data-testid="untick-all">
                Untick all
              </Button>
            </div>
            <p className="text-sm text-muted" data-testid="team-totals">
              {agents.length} agents in this pack, {ticked.length} ticked.{' '}
              <strong data-testid="adds-n">
                Adds {total} agent{total === 1 ? '' : 's'}
              </strong>
              {limit !== null && used !== null && (
                <span data-testid="plan-room">
                  {' '}
                  ({used} of {limit} on your plan)
                </span>
              )}
              .
            </p>
            {ticked.length > MAX_ITEMS && (
              <Callout tone="danger" role="alert">
                You can hire at most {MAX_ITEMS} pack agents at once ({ticked.length} ticked). Untick some.
              </Callout>
            )}
            {overLimit && (
              <Callout tone="danger" role="alert" data-testid="over-limit">
                That is {used! + total - limit!} more than your plan allows ({limit} agents). Untick some or
                lower a count.
              </Callout>
            )}
            <ul className="flex flex-col gap-2" data-testid="team-rows">
              {visible.slice(0, shown).map((a) => {
                const r = rowOf(a);
                const seatRole = roleOf(r.seat);
                const open = expanded === a.key;
                const refs = r.skills ?? a.skillRefs;
                return (
                  <li
                    key={a.key}
                    className="rounded-card border border-line p-3"
                    data-testid={`team-row-${a.key}`}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <label className="flex min-w-48 flex-1 items-center gap-2">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={r.on}
                          onChange={(e) => patch(a.key, { on: e.target.checked })}
                          aria-label={`Hire ${a.name}`}
                        />
                        {a.icon && <span aria-hidden="true">{a.icon}</span>}
                        <span className="font-medium [overflow-wrap:anywhere]">{a.name}</span>
                        {a.suggestedSeat === OWN && (
                          <Badge title="No built-in role fits by name">no seat suggested</Badge>
                        )}
                        {a.hiredAgentIds.length > 0 && <Badge>{a.hiredAgentIds.length} hired</Badge>}
                      </label>
                      <div className="w-44">
                        <Select
                          label="Seat"
                          value={r.seat}
                          onChange={(e) => patch(a.key, { seat: e.target.value as PackSeat, seniority: '' })}
                        >
                          {(team.data?.seats ?? []).map((s) => (
                            <option key={s.key} value={s.key}>
                              {s.name}
                            </option>
                          ))}
                          <option value={OWN}>Own role</option>
                        </Select>
                      </div>
                      <div className="w-20">
                        <Select
                          label="Count"
                          value={String(r.count)}
                          onChange={(e) => patch(a.key, { count: Number(e.target.value) })}
                        >
                          {[1, 2, 3, 4, 5].map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-expanded={open}
                        onClick={() => setExpanded(open ? null : a.key)}
                      >
                        {open ? 'Less' : 'Details'}
                      </Button>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted">{a.description}</p>
                    {r.on && r.seat === OWN && (
                      <p className="mt-1 text-xs text-subtle">
                        An own role works in chats and sessions, never on a card's workflow stages.
                      </p>
                    )}
                    {open && (
                      <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
                        <div className="grid gap-3 sm:grid-cols-3">
                          <TextInput
                            label="Name"
                            value={r.name}
                            placeholder={a.name}
                            maxLength={60}
                            onChange={(e) => patch(a.key, { name: e.target.value })}
                            hint={
                              r.count > 1
                                ? `Hired as ${numbering(r.name.trim() || a.name, r.count)}`
                                : 'Empty keeps the pack agent’s name'
                            }
                          />
                          <Select
                            label="Seniority"
                            value={r.seniority}
                            onChange={(e) => patch(a.key, { seniority: e.target.value })}
                          >
                            <option value="">Default ({seatRole?.seniorityLevels[0] ?? 'senior'})</option>
                            {(seatRole?.seniorityLevels ?? ['senior', 'junior']).map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </Select>
                          <TextInput
                            label="Model"
                            value={r.model}
                            list="team-model-suggestions"
                            placeholder={seatRole?.defaultModel.model ?? 'sonnet'}
                            onChange={(e) => patch(a.key, { model: e.target.value })}
                          />
                        </div>
                        <fieldset className="flex flex-col gap-1 text-sm" data-testid={`skills-${a.key}`}>
                          <legend className="font-medium">Skills</legend>
                          {a.agentSkill && (
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                className="size-4"
                                checked
                                disabled
                                aria-label={`Skill ${a.agentSkill} (always)`}
                              />
                              <code>{a.agentSkill}</code>
                              <span className="text-xs text-subtle">the agent itself, always</span>
                            </label>
                          )}
                          {a.skillRefs.map((k) => (
                            <label key={k} className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                className="size-4"
                                checked={refs.includes(k)}
                                onChange={(e) =>
                                  patch(a.key, {
                                    skills: e.target.checked
                                      ? [...new Set([...refs, k])]
                                      : refs.filter((x) => x !== k),
                                  })
                                }
                                aria-label={`Skill ${k}`}
                              />
                              <code>{k}</code>
                            </label>
                          ))}
                          {a.skillRefs.length === 0 && !a.agentSkill && (
                            <p className="text-xs text-muted">
                              None named in its files. It gets the skills of its seat.
                            </p>
                          )}
                        </fieldset>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <datalist id="team-model-suggestions">
              {modelSuggestions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {visible.length > shown && (
              <Button size="sm" onClick={() => setShown(shown + PAGE)} data-testid="show-more-agents">
                Show {Math.min(PAGE, visible.length - shown)} more ({visible.length - shown} not shown)
              </Button>
            )}
            {visible.length === 0 && <p className="text-sm text-muted">No agent matches “{search}”.</p>}

            <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
              <Select
                label="Workstation"
                value={station?.id ?? ''}
                onChange={(e) => setWorkstationId(e.target.value)}
                hint="One of yours; all agents of this hire run there."
              >
                {choices.length === 0 && <option value="">No workstation of yours is active</option>}
                {choices.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} {w.connected ? '' : '(offline)'}
                  </option>
                ))}
              </Select>
              <Select label="Runtime" value={runtime} onChange={(e) => setRuntime(e.target.value)}>
                <option value="">Each seat’s default</option>
                {runtimeOptions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </div>
            <ProjectAccessEditor
              value={effectiveAccess}
              onChange={setAccess}
              projects={projects.data ?? []}
              canAny
              idPrefix="teamhire"
            />
            {needsAck && station && (
              <div className="flex flex-col gap-2" data-testid="team-unsandboxed">
                <SandboxWarning testId="team-sandbox-warning" role="alert" lead="Warning:">
                  {agentWarning(
                    station.name,
                    sandboxReasonOf(station.runtimes, unsandboxedRuntime || effectiveRuntimes[0] || ''),
                  )}
                </SandboxWarning>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={acked}
                    onChange={(e) => setAckedFor(e.target.checked ? ackKey : '')}
                  />
                  <span>I understand these agents run without an OS sandbox on {station.name}</span>
                </label>
              </div>
            )}
            {big && (
              <label className="flex items-start gap-2 text-sm" data-testid="confirm-big">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={confirmBig}
                  onChange={(e) => setConfirmBig(e.target.checked)}
                />
                <span>I want to hire {total} agents at once</span>
              </label>
            )}
          </>
        )}
        {err && (
          <Callout tone="danger" role="alert" data-testid="team-hire-error">
            {packHireMessage(err)}
          </Callout>
        )}
      </div>
    </Dialog>
  );
}
