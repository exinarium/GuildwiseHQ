import {
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  type DefinitionIssue,
  type ExplainedRoleIssue,
  explainRoleIssues,
  type McpServerCandidateDto,
  type RoleDraftInput,
  type RoleSection,
  validateRoleDefinition,
} from '@aom/shared';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useRolePreview } from '../../api/queries/org.ts';
import { splitList } from '../../lib/designer.ts';
import {
  applyToggle,
  mcpToolsOf,
  PERMISSION_TOGGLES,
  type PermissionToggle,
  permissionSummary,
  RISK_LABEL,
  RISK_TONE,
  toggleOn,
  withFolderLimit,
  withMcpTools,
} from '../../lib/permissions-ui.ts';
import {
  type ClaimableWorkflow,
  claimsAny,
  claimsStep,
  EFFORT_OPTIONS,
  KEY_PATTERN,
  keyFromName,
  MODEL_OPTIONS,
  RUNTIME_OPTIONS,
  toggleAnyStep,
  toggleStep,
  unknownClaims,
} from '../../lib/role-builder.ts';
import { SkillPicker } from '../capabilities/SkillPicker.tsx';
import { ListInput } from '../org/ListInput.tsx';
import { RoleEditor } from '../org/RoleEditor.tsx';
import { Badge, Button, Callout, ErrorBox, Select, TextArea, TextInput } from '../ui.tsx';

const SECTIONS: Array<{ id: RoleSection | 'preview'; title: string }> = [
  { id: 'basics', title: 'Basics' },
  { id: 'instructions', title: 'How it works' },
  { id: 'permissions', title: 'What it may do' },
  { id: 'model', title: 'Model' },
  { id: 'seniority', title: 'Seniority' },
  { id: 'steps', title: 'Steps it can take' },
  { id: 'preview', title: 'Preview what the agent is told' },
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const parseLines = (t: string) =>
  t
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

/** A textarea for a list with one entry per line; keeps what is typed (blank lines while typing) locally. */
function LinesField({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
}) {
  const [raw, setRaw] = useState(value.join('\n'));
  useEffect(() => {
    setRaw((r) => (parseLines(r).join('\n') === value.join('\n') ? r : value.join('\n')));
  }, [value]);
  return (
    <TextArea
      label={label}
      rows={3}
      value={raw}
      disabled={disabled}
      {...(hint ? { hint } : {})}
      onChange={(e) => {
        setRaw(e.target.value);
        onChange(parseLines(e.target.value));
      }}
    />
  );
}

/** A form section with its heading and the issues that belong to it. */
function Section({
  id,
  title,
  hint,
  issues,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  issues: ExplainedRoleIssue[];
  children: ReactNode;
}) {
  const uid = useId();
  return (
    <section
      aria-labelledby={`${uid}-h`}
      data-testid={`section-${id}`}
      data-invalid={issues.some((i) => i.severity === 'error') || undefined}
      className="flex flex-col gap-3 rounded-control border border-border p-4"
    >
      <div>
        <h3 id={`${uid}-h`} className="text-base font-semibold text-fg">
          {title}
        </h3>
        {hint && <p className="text-sm text-muted">{hint}</p>}
      </div>
      {children}
      {issues.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" data-testid={`issues-${id}`}>
          {issues.map((i) => (
            <li key={`${i.code}-${i.text}`} data-testid="issue" data-code={i.code} className="flex gap-2">
              <Badge tone={i.severity === 'error' ? 'red' : 'amber'}>
                {i.severity === 'error' ? 'Fix' : 'Note'}
              </Badge>
              <span>{i.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The role builder (docs/design/workflow-builder.md section 3): a guided form in sections. Tools are plain-language
 * switches with a risk note, the steps a role can take are a checklist of the custom workflows' steps, problems are
 * explained in plain words and pinned to their section, and a preview shows the instructions the agent would get.
 * Saving, desk approval and versions stay as they were; the Owner alone switches on wide access.
 */
export function RoleBuilder({
  value,
  onChange,
  departments,
  workflows,
  knownSkills = [],
  knownMcpServers = [],
  isOwner,
  keyLocked = false,
  serverIssues,
  readOnly = false,
  projectId,
}: {
  value: RoleDraftInput;
  onChange: (v: RoleDraftInput) => void;
  departments: readonly string[];
  /** The custom workflows (and their agent steps) this role can take steps of. */
  workflows: readonly ClaimableWorkflow[];
  /** Skills other roles use, offered as quick picks. */
  knownSkills?: readonly string[];
  /** Plugin MCP servers the organization's workstations report: offered as picks for the external tools. */
  knownMcpServers?: readonly McpServerCandidateDto[];
  /** The signed-in user is the organization Owner: only they switch on wide access. */
  isOwner: boolean;
  /** The short name of an existing role cannot change. */
  keyLocked?: boolean;
  serverIssues?: readonly DefinitionIssue[] | undefined;
  readOnly?: boolean;
  projectId?: string | undefined;
}) {
  const set = (patch: Partial<RoleDraftInput>) => onChange({ ...value, ...patch });
  const [advanced, setAdvanced] = useState(false);
  const keyTouched = useRef(value.key !== '');
  const [skillText, setSkillText] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewStep, setPreviewStep] = useState('');
  const [previewSeniority, setPreviewSeniority] = useState<'junior' | 'senior'>(
    value.seniorityLevels[0] ?? 'junior',
  );

  const explained = useMemo(() => {
    const raw =
      serverIssues && serverIssues.length > 0
        ? serverIssues
        : validateRoleDefinition(
            // An empty short name would hide every other problem behind the one schema error; check the rest first.
            { ...value, key: value.key || 'new-role', version: 1, builtIn: false },
            {
              builtinRoleKeys: BUILTIN_ROLES.map((r) => r.key),
              builtinWorkflowKeys: BUILTIN_WORKFLOWS.map((w) => w.key),
              departments,
            },
          );
    const out = explainRoleIssues(raw);
    if (!value.key && !(serverIssues && serverIssues.length > 0))
      out.unshift({
        severity: 'error',
        code: 'invalid_schema',
        text: 'Give the role a short name (key). It is filled in from the name; you can change it until the first save.',
        section: 'basics',
        issue: { severity: 'error', code: 'invalid_schema', message: 'key: required', field: 'key' },
      });
    return out;
  }, [value, departments, serverIssues]);
  const bySection = (s: RoleSection) => explained.filter((i) => i.section === s);
  const errors = explained.filter((i) => i.severity === 'error').length;

  const perms = value.permissions;
  const setPerms = (p: typeof perms) => set({ permissions: p });
  const claimable = workflows.flatMap((w) => w.steps.map((s) => ({ wf: w, step: s })));
  const stale = unknownClaims(value.claimableStages, workflows);

  // ---- preview
  const claimedSteps = claimable.filter(({ wf, step }) => claimsStep(value.claimableStages, wf.key, step.id));
  const [pwf, pstage] = previewStep.split('|');
  const request = useMemo(
    () =>
      previewOpen && KEY_PATTERN.test(value.key)
        ? {
            role: value,
            seniority: previewSeniority,
            ...(pwf && pstage ? { workflowKey: pwf, stageId: pstage } : {}),
          }
        : null,
    [previewOpen, value, previewSeniority, pwf, pstage],
  );
  const debounced = useDebounced(request, 500);
  const preview = useRolePreview(debounced, projectId);

  if (advanced) {
    return (
      <div className="flex flex-col gap-3" data-testid="role-builder">
        <div>
          <Button onClick={() => setAdvanced(false)}>Back to the guided form</Button>
        </div>
        <RoleEditor
          value={value}
          onChange={onChange}
          departments={departments}
          serverIssues={serverIssues}
          readOnly={readOnly}
        />
      </div>
    );
  }

  const toggleRow = (t: PermissionToggle) => {
    const locked = readOnly || t.fixed || (t.ownerOnly && !isOwner);
    const id = `perm-${t.id}`;
    return (
      <li key={t.id} data-testid={`toggle-${t.id}`} className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 text-sm font-medium" htmlFor={id}>
            <input
              id={id}
              type="checkbox"
              checked={toggleOn(perms, t.id)}
              disabled={locked}
              aria-describedby={`${id}-risk`}
              onChange={(e) => setPerms(applyToggle(perms, t.id, e.target.checked))}
            />
            {t.label}
          </label>
          <Badge tone={RISK_TONE[t.risk]}>{RISK_LABEL[t.risk]}</Badge>
          {t.ownerOnly && <Badge tone="violet">Owner only</Badge>}
        </div>
        <p className="ml-6 text-sm text-muted">{t.does}</p>
        <p id={`${id}-risk`} className="ml-6 text-xs text-subtle" data-testid={`risk-${t.id}`}>
          {t.riskNote}
          {t.ownerOnly && !isOwner && ' You are an Admin: ask the Owner to switch this on.'}
        </p>
      </li>
    );
  };

  const summary = permissionSummary(perms);
  const addSkills = (names: string[]) => {
    const next = [...new Set([...value.skills, ...names.map((n) => n.trim()).filter(Boolean)])];
    set({ skills: next });
  };
  const modelKnown = MODEL_OPTIONS.some((m) => m.id === value.defaultModel.model);
  const runtimeKnown = RUNTIME_OPTIONS.some((r) => r.id === value.defaultModel.runtime);
  const effortKnown = EFFORT_OPTIONS.some((e) => e.id === (value.defaultModel.effort ?? ''));
  const suggestions = knownSkills.filter((s) => !value.skills.includes(s));

  return (
    <div className="flex flex-col gap-4" data-testid="role-builder">
      <div
        data-testid="issue-bar"
        data-errors={errors}
        role="status"
        className="flex flex-wrap items-center gap-2 text-sm"
      >
        {errors === 0 ? (
          <span className="text-success" data-testid="validation-ok">
            Nothing to fix.
          </span>
        ) : (
          <span className="font-medium text-danger">
            {errors === 1 ? '1 thing to fix' : `${errors} things to fix`} before this role can be sent for
            approval.
          </span>
        )}
        <span className="ml-auto flex gap-2">
          <Link to="/org?tab=design" className="text-sm underline">
            Ask the BA to help
          </Link>
          <Button size="sm" onClick={() => setAdvanced(true)}>
            Advanced: all fields
          </Button>
        </span>
      </div>
      <nav aria-label="Role sections" className="flex flex-wrap gap-2 text-xs text-muted">
        {SECTIONS.map((s, i) => (
          <span key={s.id}>
            {i + 1}. {s.title}
          </span>
        ))}
      </nav>

      <Section
        id="basics"
        title="Basics"
        hint="What this role is called and what it is for."
        issues={bySection('basics')}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <TextInput
            label="Name"
            value={value.name}
            disabled={readOnly}
            onChange={(e) => {
              const name = e.target.value;
              set({ name, ...(keyTouched.current || keyLocked ? {} : { key: keyFromName(name) }) });
            }}
          />
          <TextInput
            label="Short name (key)"
            value={value.key}
            disabled={readOnly || keyLocked}
            hint={
              keyLocked
                ? 'The short name of an existing role cannot change.'
                : 'Lowercase letters, digits, - and _. Cannot be changed later.'
            }
            onChange={(e) => {
              keyTouched.current = true;
              set({ key: e.target.value });
            }}
          />
          <Select
            label="Department"
            value={value.department ?? ''}
            disabled={readOnly}
            onChange={(e) => set({ department: e.target.value || undefined })}
          >
            <option value="">None</option>
            {departments.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </Select>
        </div>
        <TextInput
          label="Purpose"
          value={value.purpose}
          disabled={readOnly}
          hint="One sentence on what this role is for. Shown on the role card and when hiring."
          onChange={(e) => set({ purpose: e.target.value })}
        />
      </Section>

      <Section
        id="instructions"
        title="How it works"
        hint="Tell the role how to do its work, like a short briefing for a new colleague."
        issues={bySection('instructions')}
      >
        <TextArea
          label="Instructions"
          rows={8}
          value={value.instructions}
          disabled={readOnly}
          onChange={(e) => set({ instructions: e.target.value })}
        />
        <LinesField
          label="Rules that always apply (one per line)"
          value={value.coreRules}
          disabled={readOnly}
          hint="Core rules. You cannot override them later, so keep them to what must never change."
          onChange={(coreRules) => set({ coreRules })}
        />
      </Section>

      <Section
        id="permissions"
        title="What it may do"
        hint="Switch on only what this role needs. Every agent works in its own copy and can never push, rebase or switch branches."
        issues={bySection('permissions')}
      >
        <ul className="flex flex-col gap-3" data-testid="permission-toggles">
          {PERMISSION_TOGGLES.map(toggleRow)}
        </ul>
        <div className="flex flex-col gap-2">
          <label className="inline-flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={perms.writableGlobs !== null}
              disabled={readOnly}
              onChange={(e) => setPerms(withFolderLimit(perms, e.target.checked ? [] : null))}
            />
            Only these folders
          </label>
          <p className="ml-6 text-xs text-subtle">
            Narrows where it may change files, for example docs/** (comma separated). Off: the whole card
            copy.
          </p>
          {perms.writableGlobs !== null && (
            <ListInput
              label="Folders it may change"
              value={perms.writableGlobs}
              disabled={readOnly}
              onChange={(v) => setPerms(withFolderLimit(perms, v))}
            />
          )}
        </div>
        {knownMcpServers.length > 0 && (
          <fieldset className="flex flex-col gap-2" data-testid="mcp-picker">
            <legend className="text-sm font-medium">
              External tools your workstations offer (MCP servers)
            </legend>
            {knownMcpServers.map((s) => {
              const on = mcpToolsOf(perms).includes(s.name);
              return (
                <label key={s.name} className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={readOnly}
                    onChange={(e) =>
                      setPerms(
                        withMcpTools(
                          perms,
                          e.target.checked
                            ? [...mcpToolsOf(perms), s.name]
                            : mcpToolsOf(perms).filter((n) => n !== s.name),
                        ),
                      )
                    }
                  />
                  {s.plugin} / {s.server}
                  <span className="font-mono text-xs text-subtle">mcp:{s.name}</span>
                </label>
              );
            })}
            <p className="text-xs text-subtle">
              A role can only use a server the project's Owner also granted in the project settings (MCP
              servers). Each server is a separate risk: only add tools you trust.
            </p>
          </fieldset>
        )}
        <ListInput
          label="External tools (MCP, comma separated)"
          value={mcpToolsOf(perms)}
          disabled={readOnly}
          hint="Names of tool servers this role may use, as listed above. Each one is a separate risk: only add tools you trust."
          onChange={(v) => setPerms(withMcpTools(perms, v))}
        />
        <div data-testid="permission-summary" className="rounded-control bg-surface-sunken p-3 text-sm">
          <p>
            <strong>This role can:</strong> {summary.can.join('; ')}.
          </p>
          <p>
            <strong>It cannot:</strong> {summary.cannot.join('; ')}.
          </p>
        </div>
      </Section>

      <Section
        id="model"
        title="Model"
        hint="The AI model new hires of this role start with. Stronger models cost more per shift."
        issues={bySection('model')}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label="Runtime"
            value={value.defaultModel.runtime}
            disabled={readOnly}
            onChange={(e) => set({ defaultModel: { ...value.defaultModel, runtime: e.target.value } })}
          >
            {!runtimeKnown && (
              <option value={value.defaultModel.runtime}>{value.defaultModel.runtime}</option>
            )}
            {RUNTIME_OPTIONS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
          <Select
            label="Model"
            value={value.defaultModel.model}
            disabled={readOnly}
            onChange={(e) => set({ defaultModel: { ...value.defaultModel, model: e.target.value } })}
          >
            {!modelKnown && <option value={value.defaultModel.model}>{value.defaultModel.model}</option>}
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
          <Select
            label="Effort"
            value={value.defaultModel.effort ?? ''}
            disabled={readOnly}
            onChange={(e) =>
              set({ defaultModel: { ...value.defaultModel, effort: e.target.value || undefined } })
            }
          >
            {!effortKnown && <option value={value.defaultModel.effort}>{value.defaultModel.effort}</option>}
            {EFFORT_OPTIONS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </Select>
        </div>
      </Section>

      <Section
        id="seniority"
        title="Seniority"
        hint="Which levels you can hire this role at. Senior agents take the steps marked senior only."
        issues={bySection('seniority')}
      >
        <fieldset className="flex flex-wrap items-center gap-4 text-sm" disabled={readOnly}>
          <legend className="sr-only">Seniority levels</legend>
          {(['junior', 'senior'] as const).map((s) => (
            <label key={s} className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={value.seniorityLevels.includes(s)}
                onChange={(e) =>
                  set({
                    seniorityLevels: e.target.checked
                      ? [...value.seniorityLevels, s]
                      : value.seniorityLevels.filter((x) => x !== s),
                  })
                }
              />
              {s === 'junior' ? 'Junior' : 'Senior'}
            </label>
          ))}
        </fieldset>
        <div>
          <p className="mb-1 text-sm font-medium">Skills</p>
          <ul className="mb-2 flex flex-wrap gap-2" data-testid="skills">
            {value.skills.map((s) => (
              <li key={s}>
                <Badge tone="blue">
                  {s}{' '}
                  <button
                    type="button"
                    aria-label={`Remove skill ${s}`}
                    disabled={readOnly}
                    onClick={() => set({ skills: value.skills.filter((x) => x !== s) })}
                  >
                    x
                  </button>
                </Badge>
              </li>
            ))}
            {value.skills.length === 0 && <li className="text-sm text-subtle">No skills added.</li>}
          </ul>
          <div className="flex items-end gap-2">
            <TextInput
              label="Add a skill"
              value={skillText}
              disabled={readOnly}
              onChange={(e) => setSkillText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addSkills(splitList(skillText));
                  setSkillText('');
                }
              }}
            />
            <Button
              disabled={readOnly || !skillText.trim()}
              onClick={() => {
                addSkills(splitList(skillText));
                setSkillText('');
              }}
            >
              Add skill
            </Button>
          </div>
          {suggestions.length > 0 && (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-subtle">
              Used by other roles:
              {suggestions.map((s) => (
                <Button key={s} size="sm" variant="ghost" disabled={readOnly} onClick={() => addSkills([s])}>
                  + {s}
                </Button>
              ))}
            </p>
          )}
          <SkillPicker
            value={value.skills}
            onChange={(skills) => set({ skills })}
            disabled={readOnly}
            projectId={projectId}
          />
        </div>
      </Section>

      <Section
        id="steps"
        title="Steps it can take"
        hint="Tick the steps of your custom workflows this role may work on. A step is given to an agent of the role the workflow names."
        issues={bySection('steps')}
      >
        {workflows.length === 0 ? (
          <Callout tone="info" data-testid="no-workflows">
            You have no custom workflows yet. Create a workflow first (or draft it together with this role);
            then come back and tick its steps.
          </Callout>
        ) : (
          <div className="flex flex-col gap-3" data-testid="claims">
            {workflows.map((wf) => {
              const any = claimsAny(value.claimableStages, wf.key);
              return (
                <fieldset
                  key={wf.key}
                  className="rounded-control border border-border p-3"
                  disabled={readOnly}
                >
                  <legend className="px-1 text-sm font-medium">
                    {wf.name}{' '}
                    {wf.status !== 'active' && (
                      <Badge tone="blue">{wf.status === 'draft' ? 'Draft' : 'Waiting for approval'}</Badge>
                    )}
                  </legend>
                  {wf.steps.length === 0 ? (
                    <p className="text-sm text-subtle">This workflow has no steps for an agent yet.</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      <li>
                        <label className="inline-flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={any}
                            onChange={(e) =>
                              set({
                                claimableStages: toggleAnyStep(
                                  value.claimableStages,
                                  wf.key,
                                  e.target.checked,
                                ),
                              })
                            }
                          />
                          Any step of {wf.name}
                        </label>
                      </li>
                      {wf.steps.map((s) => (
                        <li key={s.id} className="ml-6">
                          <label className="inline-flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={claimsStep(value.claimableStages, wf.key, s.id)}
                              onChange={(e) =>
                                set({
                                  claimableStages: toggleStep(
                                    value.claimableStages,
                                    wf,
                                    s.id,
                                    e.target.checked,
                                  ),
                                })
                              }
                            />
                            {s.label}
                            {s.claimRole && s.claimRole !== value.key && (
                              <span className="text-xs text-subtle">(now worked by {s.claimRole})</span>
                            )}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </fieldset>
              );
            })}
          </div>
        )}
        {stale.length > 0 && (
          <div data-testid="stale-claims" className="flex flex-col gap-1 text-sm">
            <p className="font-medium">Steps that are not in any of your workflows (kept as they are):</p>
            <ul className="flex flex-wrap gap-2">
              {stale.map((c) => (
                <li key={`${c.workflowKey}.${c.stageId}`}>
                  <Badge tone="amber">
                    {c.workflowKey}.{c.stageId}{' '}
                    <button
                      type="button"
                      aria-label={`Remove ${c.workflowKey}.${c.stageId}`}
                      disabled={readOnly}
                      onClick={() =>
                        set({
                          claimableStages: value.claimableStages.filter(
                            (x) => !(x.workflowKey === c.workflowKey && x.stageId === c.stageId),
                          ),
                        })
                      }
                    >
                      x
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section
        id="preview"
        title="Preview what the agent is told"
        hint="Shows the instructions file an agent with this role would get, using a sample card. Nothing runs and nothing costs anything."
        issues={[]}
      >
        {!previewOpen ? (
          <div>
            <Button onClick={() => setPreviewOpen(true)}>Preview the prompt</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3" data-testid="prompt-preview-panel">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label="Sample step"
                value={previewStep}
                onChange={(e) => setPreviewStep(e.target.value)}
              >
                <option value="">A generic step</option>
                {claimedSteps.map(({ wf, step }) => (
                  <option key={`${wf.key}|${step.id}`} value={`${wf.key}|${step.id}`}>
                    {wf.name}: {step.label}
                  </option>
                ))}
              </Select>
              <Select
                label="Sample hire"
                value={previewSeniority}
                onChange={(e) => setPreviewSeniority(e.target.value as 'junior' | 'senior')}
              >
                {(value.seniorityLevels.length ? value.seniorityLevels : ['junior', 'senior']).map((s) => (
                  <option key={s} value={s}>
                    {s === 'junior' ? 'Junior' : 'Senior'}
                  </option>
                ))}
              </Select>
            </div>
            {!KEY_PATTERN.test(value.key) && (
              <p className="text-sm text-muted" data-testid="preview-needs-key">
                Give the role a name first: the preview needs its short name.
              </p>
            )}
            {preview.isError && <ErrorBox error={preview.error} />}
            {preview.data && request && (
              <>
                <p className="text-xs text-subtle" data-testid="preview-headings">
                  Sections: {preview.data.headings.join(', ')}
                </p>
                <pre
                  data-testid="prompt-preview"
                  className="max-h-96 overflow-auto whitespace-pre-wrap rounded-control bg-surface-sunken p-3 text-xs"
                >
                  {preview.data.text}
                </pre>
              </>
            )}
            <div>
              <Button size="sm" onClick={() => setPreviewOpen(false)}>
                Hide the preview
              </Button>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
