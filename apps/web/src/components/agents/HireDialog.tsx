import {
  type AgentDraftDto,
  backendDef,
  modelChoicesFor,
  NAME_THEMES,
  type RoleDefinition,
  runtimeRoleProblem,
  splitBackendModel,
} from '@aom/shared';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useHireFromDraft } from '../../api/queries/agent-ux.ts';
import { useHire, useNameSuggestions, useRoles } from '../../api/queries/agents.ts';
import { useMe } from '../../api/queries/auth.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import { getLastProjectKey } from '../../lib/lastProject.ts';
import { agentWarning, isRuntimeUnsandboxed, sandboxReasonOf } from '../../lib/sandbox.ts';
import { unionExtras } from '../ModelSelect.tsx';
import { SandboxWarning } from '../SandboxWarning.tsx';
import { Button, Callout, Dialog, ErrorBox, Select, TextInput } from '../ui.tsx';
import { type Access, ProjectAccessEditor } from './ProjectAccess.tsx';

/** The hire form. With a `draft` (from "Describe the agent you need" or a starter persona) the role is the reviewed draft. */
export function HireDialog({
  open,
  onOpenChange,
  prefill,
  draft,
  starterKey,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  prefill?: { roleKey: string; projectId: string; seniority?: string } | null;
  /** A reviewed draft: the agent gets a role made from it (permissions clamped by the server), not one of the catalogue. */
  draft?: AgentDraftDto | null;
  /** The starter gallery entry the draft came from. */
  starterKey?: string;
}) {
  const stations = useWorkstations();
  const projects = useProjects();
  const hire = useHire();
  const hireDraft = useHireFromDraft();
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

  // a draft brings its name and its suggested skills; the person may change both below
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when another draft arrives
  useEffect(() => {
    if (!draft) return;
    setName(draft.name);
    setSkills(draft.skills.join(', '));
  }, [draft]);

  const hireable = useMemo(
    // The CEO is appointed on the CEO page, never hired here.
    () => (roles.data ?? []).filter((r) => r.definition.key !== 'devops' && r.definition.key !== 'ceo'),
    [roles.data],
  );
  const activeStations = (stations.data ?? []).filter((w) => w.status === 'active');
  const effectiveRoleKey = roleKey || hireable[0]?.definition.key || '';
  const draftRole: RoleDefinition | undefined = draft
    ? {
        key: 'draft',
        version: 1,
        name: draft.name,
        purpose: draft.purpose,
        builtIn: false,
        instructions: draft.instructions,
        coreRules: [],
        seniorityLevels: ['senior', 'junior'],
        defaultModel: { runtime: 'claude-code', model: draft.model, effort: 'medium' },
        permissions: draft.permissions,
        skills: draft.skills,
        claimableStages: [],
        chatOnly: true,
      }
    : undefined;
  const role = draftRole ?? hireable.find((r) => r.definition.key === effectiveRoleKey)?.definition;
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
        // the direct API models have no shell or edit tools: an agent cannot run on them (the server refuses it)
        ...(station?.runtimes.filter((r) => r.available && r.id !== 'direct-model').map((r) => r.id) ?? []),
      ].filter(Boolean) as string[],
    ),
  ];

  const effectiveRuntime = runtime || role?.defaultModel.runtime || '';
  // Whether the role can run on the chosen runtime (the same rule the server and the runner apply), and which models the
  // workstation offers for it: the Gemini CLI and opencode lists and the Bedrock, Vertex and gateway models are the workstation's.
  const runtimeProblem = role?.permissions
    ? runtimeRoleProblem(effectiveRuntime, { roleKey: role.key, permissions: role.permissions })
    : null;
  const stationList = station ? [station] : [];
  // no direct providers: an agent never runs on the direct API models
  const modelSuggestions = modelChoicesFor([effectiveRuntime], [], unionExtras(stationList)).flatMap((g) =>
    g.models.map((m) => m.id),
  );
  const typedBackend = splitBackendModel(model.trim());
  const modelCaution = typedBackend ? backendDef(typedBackend.backend)?.warning : undefined;
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
    if (runtimeProblem) errs.runtime = runtimeProblem;
    if (effectiveAccess.allowed !== null && effectiveAccess.allowed.length === 0)
      errs.access = 'Pick at least one project, or allow any project';
    if (!effectiveStation) errs.workstation = 'Pair a workstation first';
    setErrors(errs);
    if (Object.keys(errs).length || !role) return;
    const typedSkills = skills
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const common = {
      name: name.trim(),
      seniority: effectiveSeniority as 'junior' | 'senior',
      workstationId: effectiveStation,
      allowedProjectIds: effectiveAccess.allowed,
      ...(effectiveAccess.focus.length ? { focusProjectIds: effectiveAccess.focus } : {}),
      ...(runtime ? { runtime } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(effort ? { effort } : {}),
      ...(unsandboxed && ackUnsandboxed ? { acknowledgeUnsandboxed: true } : {}),
      capacity: 1,
    };
    const done = {
      onSuccess: () => {
        setName('');
        setAccess(null);
        setNonce((n) => n + 1);
        onOpenChange(false);
      },
    };
    if (draft) {
      const { permissions: _p, withheld: _w, ...d } = draft;
      hireDraft.mutate(
        { ...common, skills: typedSkills, draft: d, ...(starterKey ? { starterKey } : {}) },
        done,
      );
      // an empty box hires with the role's own skills (sending [] would hire with none)
    } else
      hire.mutate(
        { ...common, roleKey: role.key, ...(typedSkills.length ? { skills: typedSkills } : {}) },
        done,
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
        {draft && (
          <div
            className="rounded-control border border-line bg-sunken px-3 py-2 text-sm"
            data-testid="hire-draft-role"
          >
            <p className="font-medium text-fg">New role: {draft.name}</p>
            <p className="text-muted">{draft.purpose}</p>
            <p className="text-xs text-subtle">
              It may {draft.permissions.allowedTools.join(', ')}. It works in chats, sessions and when
              mentioned; it does not take cards from the board.
            </p>
          </div>
        )}
        {!draft && (
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
        )}
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
            error={errors.runtime}
          >
            {runtimeOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <div>
            <TextInput
              label="Model"
              placeholder={role?.defaultModel.model}
              value={model}
              list="hire-model-suggestions"
              onChange={(e) => setModel(e.target.value)}
            />
            <datalist id="hire-model-suggestions">
              {modelSuggestions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
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
        {runtimeProblem && (
          <Callout tone="danger" role="alert" data-testid="hire-runtime-problem">
            This role cannot run on {effectiveRuntime}: {runtimeProblem}
          </Callout>
        )}
        {modelCaution && (
          <Callout tone="warning" data-testid="hire-model-caution">
            {modelCaution}
          </Callout>
        )}
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
          hint={
            draft
              ? 'Comma separated, optional'
              : "Comma separated, optional. Leave empty for the role's skills; what you type replaces them."
          }
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
        <ErrorBox error={hire.error ?? hireDraft.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={hire.isPending || hireDraft.isPending}>
            Hire
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
