import {
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  type DefinitionIssue,
  type RoleDraftInput,
  validateRoleDefinition,
} from '@aom/shared';
import { useMemo } from 'react';
import { claimText, parseClaims } from '../../lib/designer.ts';
import { Badge, Select, TextArea, TextInput } from '../ui.tsx';
import { ListInput } from './ListInput.tsx';

const TOOLS = ['read', 'edit', 'shell', 'web'] as const;

/** The custom role form: name, purpose, instructions, permissions, tools and skills, model, seniority, claimable stages. */
export function RoleEditor({
  value,
  onChange,
  departments,
  serverIssues,
  readOnly = false,
}: {
  value: RoleDraftInput;
  onChange: (v: RoleDraftInput) => void;
  departments: readonly string[];
  serverIssues?: readonly DefinitionIssue[];
  readOnly?: boolean;
}) {
  const set = (patch: Partial<RoleDraftInput>) => onChange({ ...value, ...patch });
  const issues: DefinitionIssue[] = useMemo(
    () =>
      validateRoleDefinition(
        { ...value, version: 1, builtIn: false },
        {
          builtinRoleKeys: BUILTIN_ROLES.map((r) => r.key),
          builtinWorkflowKeys: BUILTIN_WORKFLOWS.map((w) => w.key),
          departments,
        },
      ).map((i) => ({ ...i })),
    [value, departments],
  );
  const shown = serverIssues && serverIssues.length > 0 ? serverIssues : issues;
  const tools = value.permissions.allowedTools;
  return (
    <div className="flex flex-col gap-3" data-testid="role-editor">
      <div className="grid gap-3 sm:grid-cols-3">
        <TextInput
          label="Key"
          value={value.key}
          disabled={readOnly}
          hint="Lowercase letters, digits, - and _"
          onChange={(e) => set({ key: e.target.value })}
        />
        <TextInput
          label="Name"
          value={value.name}
          disabled={readOnly}
          onChange={(e) => set({ name: e.target.value })}
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
        onChange={(e) => set({ purpose: e.target.value })}
      />
      <TextArea
        label="Instructions"
        rows={6}
        value={value.instructions}
        disabled={readOnly}
        onChange={(e) => set({ instructions: e.target.value })}
      />
      <TextArea
        label="Core rules (one per line; the owner cannot override them later)"
        rows={2}
        value={value.coreRules.join('\n')}
        disabled={readOnly}
        onChange={(e) =>
          set({
            coreRules: e.target.value
              .split('\n')
              .map((x) => x.trim())
              .filter(Boolean),
          })
        }
      />
      <fieldset className="flex flex-wrap items-center gap-3 text-sm" disabled={readOnly}>
        <legend className="mb-1 text-xs font-medium text-muted">Seniority levels</legend>
        {(['junior', 'senior'] as const).map((s) => (
          <label key={s} className="inline-flex items-center gap-1">
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
            {s}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextInput
          label="Default runtime"
          value={value.defaultModel.runtime}
          disabled={readOnly}
          onChange={(e) => set({ defaultModel: { ...value.defaultModel, runtime: e.target.value } })}
        />
        <TextInput
          label="Default model"
          value={value.defaultModel.model}
          disabled={readOnly}
          onChange={(e) => set({ defaultModel: { ...value.defaultModel, model: e.target.value } })}
        />
        <TextInput
          label="Effort (optional)"
          value={value.defaultModel.effort ?? ''}
          disabled={readOnly}
          onChange={(e) =>
            set({ defaultModel: { ...value.defaultModel, effort: e.target.value || undefined } })
          }
        />
      </div>
      <fieldset className="flex flex-wrap items-center gap-3 text-sm" disabled={readOnly}>
        <legend className="mb-1 text-xs font-medium text-muted">Tools</legend>
        {TOOLS.map((t) => (
          <label key={t} className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={tools.includes(t)}
              onChange={(e) =>
                set({
                  permissions: {
                    ...value.permissions,
                    allowedTools: e.target.checked ? [...tools, t] : tools.filter((x) => x !== t),
                  },
                })
              }
            />
            {t}
          </label>
        ))}
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={value.permissions.mayCommit}
            onChange={(e) => set({ permissions: { ...value.permissions, mayCommit: e.target.checked } })}
          />
          may commit
        </label>
        <label
          className="inline-flex items-center gap-1"
          title="Lets the shell create Unix sockets so Playwright/Chromium can start. Docker, WSL interop, dbus and ssh-agent sockets stay hidden."
        >
          <input
            type="checkbox"
            checked={value.permissions.browser ?? false}
            disabled={readOnly}
            onChange={(e) => set({ permissions: { ...value.permissions, browser: e.target.checked } })}
          />
          runs browsers
        </label>
      </fieldset>
      <ListInput
        label="Denied shell patterns (comma separated)"
        value={value.permissions.deniedShellPatterns}
        disabled={readOnly}
        onChange={(v) => set({ permissions: { ...value.permissions, deniedShellPatterns: v } })}
      />
      <ListInput
        label="Skills (comma separated)"
        value={value.skills}
        disabled={readOnly}
        onChange={(v) => set({ skills: v })}
      />
      <ListInput
        label="May claim (workflow.stage, comma separated; * for any stage)"
        value={value.claimableStages}
        parse={parseClaims}
        format={claimText}
        disabled={readOnly}
        hint="Custom roles claim stages of your custom workflows, for example support.triage or support.*"
        onChange={(v) => set({ claimableStages: v })}
      />
      <section
        aria-label="Validation"
        data-testid="validation"
        data-errors={shown.filter((i) => i.severity === 'error').length}
      >
        {shown.length === 0 ? (
          <p className="text-sm text-success" data-testid="validation-ok">
            No issues.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {shown.map((i) => (
              <li
                key={`${i.code}-${i.message}`}
                data-testid="issue"
                data-code={i.code}
                className="text-danger"
              >
                <Badge tone={i.severity === 'error' ? 'red' : 'amber'}>{i.severity}</Badge> {i.message}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
