import {
  type AuthoredCapability,
  type AuthoredIssue,
  authoredHasErrors,
  capabilitiesOfTree,
  PERSONA_TOOL_PROFILES,
  packTree,
  validateAuthoredPack,
  zipTree,
} from '@aom/shared';
import { useMemo, useState } from 'react';
import { Badge, Button, Callout, TextArea, TextInput } from '../ui.tsx';

/**
 * The capability editor: skills (SKILL.md and optional reference, asset and script files), personas (the frontmatter fields and
 * the prompt) and playbooks (workflow.md and numbered steps). The shared parsers validate live; what is stored is the pack in the
 * standard layout, so it can be exported as a git-ready folder and published unchanged.
 */

const blank = (kind: AuthoredCapability['kind'], key: string): AuthoredCapability =>
  kind === 'skill'
    ? { kind, key, description: '', body: '', files: {} }
    : kind === 'persona'
      ? {
          kind,
          key,
          name: '',
          description: '',
          stance: '',
          voice: '',
          icon: '',
          tools: ['read'],
          skills: [],
          prompt: '',
        }
      : { kind, key, description: '', workflow: '', steps: [], files: {} };

export const slugOf = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const issuesFor = (all: AuthoredIssue[], c: AuthoredCapability): AuthoredIssue[] => {
  const id = `${c.kind}:${c.key}`;
  const main =
    c.kind === 'skill'
      ? `skills/${c.key}/`
      : c.kind === 'persona'
        ? `personas/${c.key}.md`
        : `playbooks/${c.key}/`;
  return all.filter((i) => i.path === id || i.path.startsWith(main));
};

function Issues({ list }: { list: AuthoredIssue[] }) {
  if (list.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-xs" data-testid="editor-issues">
      {list.map((i) => (
        <li
          key={`${i.path}:${i.message}`}
          className={i.severity === 'error' ? 'text-danger' : 'text-warning'}
          data-severity={i.severity}
        >
          <strong>{i.severity === 'error' ? 'Error' : 'Note'}:</strong> {i.message}{' '}
          <code className="text-subtle">{i.path}</code>
        </li>
      ))}
    </ul>
  );
}

function FilesEditor({
  prefixes,
  files,
  onChange,
}: {
  prefixes: readonly string[];
  files: Record<string, string>;
  onChange: (f: Record<string, string>) => void;
}) {
  const [path, setPath] = useState('');
  const set = (p: string, t: string) => onChange({ ...files, [p]: t });
  return (
    <fieldset className="flex flex-col gap-2" data-testid="extra-files">
      <legend className="text-sm font-medium">Extra files</legend>
      {Object.entries(files).map(([p, t]) => (
        <div key={p} className="flex flex-col gap-1 rounded-card border border-line p-2">
          <div className="flex items-center gap-2 text-xs">
            <code>{p}</code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const { [p]: _gone, ...rest } = files;
                onChange(rest);
              }}
            >
              Remove
            </Button>
          </div>
          <TextArea label={`Content of ${p}`} value={t} rows={4} onChange={(e) => set(p, e.target.value)} />
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-2">
        <TextInput
          label="New file path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={`${prefixes[0]}notes.md`}
          hint={`Under ${prefixes.join(', ')}. Text files only. A script file stays off until the pack is approved and scripts are enabled.`}
        />
        <Button
          disabled={!path.trim() || path.trim() in files}
          onClick={() => {
            set(path.trim(), '');
            setPath('');
          }}
        >
          Add file
        </Button>
      </div>
    </fieldset>
  );
}

function SkillForm({
  c,
  onChange,
}: {
  c: Extract<AuthoredCapability, { kind: 'skill' }>;
  onChange: (c: AuthoredCapability) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <TextArea
        label="Description"
        value={c.description}
        rows={2}
        onChange={(e) => onChange({ ...c, description: e.target.value })}
        hint="What it does and when to use it. Agents see this line first."
      />
      <TextArea
        label="Instructions (SKILL.md)"
        value={c.body}
        rows={10}
        onChange={(e) => onChange({ ...c, body: e.target.value })}
      />
      <FilesEditor
        prefixes={['references/', 'assets/', 'scripts/']}
        files={c.files}
        onChange={(files) => onChange({ ...c, files })}
      />
    </div>
  );
}

function PersonaForm({
  c,
  onChange,
}: {
  c: Extract<AuthoredCapability, { kind: 'persona' }>;
  onChange: (c: AuthoredCapability) => void;
}) {
  const tools = c.tools ?? [];
  const profile =
    PERSONA_TOOL_PROFILES.find(
      (p) => p.tools.length === tools.length && p.tools.every((t) => tools.includes(t)),
    )?.id ?? 'custom';
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput label="Name" value={c.name} onChange={(e) => onChange({ ...c, name: e.target.value })} />
        <TextInput
          label="Icon"
          value={c.icon}
          onChange={(e) => onChange({ ...c, icon: e.target.value })}
          hint="An emoji or a short word."
        />
      </div>
      <TextArea
        label="Description"
        value={c.description}
        rows={2}
        onChange={(e) => onChange({ ...c, description: e.target.value })}
      />
      <TextInput
        label="Stance"
        value={c.stance}
        onChange={(e) => onChange({ ...c, stance: e.target.value })}
        hint="The position it argues from."
      />
      <TextInput
        label="Voice"
        value={c.voice}
        onChange={(e) => onChange({ ...c, voice: e.target.value })}
        hint="How it speaks."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput
          label="Model (optional)"
          value={c.model ?? ''}
          onChange={(e) => {
            const { model: _m, ...rest } = c;
            onChange(e.target.value ? { ...rest, model: e.target.value } : rest);
          }}
          hint="Advisory, for example sonnet. The person who talks to it can choose another."
        />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Tools profile</span>
          <select
            className="rounded-input border border-line bg-surface px-2 py-1.5"
            value={profile}
            data-testid="tools-profile"
            onChange={(e) => {
              const p = PERSONA_TOOL_PROFILES.find((x) => x.id === e.target.value);
              if (p) onChange({ ...c, tools: [...p.tools] });
            }}
          >
            {PERSONA_TOOL_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            {profile === 'custom' && <option value="custom">Custom ({tools.join(', ')})</option>}
          </select>
          <span className="text-xs text-muted">
            Used when the persona is hired as an agent: never wider than the person hiring may grant. Read
            only when empty.
          </span>
        </label>
      </div>
      <TextInput
        label="Skills it uses (keys, comma separated)"
        value={(c.skills ?? []).join(', ')}
        onChange={(e) =>
          onChange({
            ...c,
            skills: e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
      />
      <TextArea
        label="Prompt"
        value={c.prompt}
        rows={10}
        onChange={(e) => onChange({ ...c, prompt: e.target.value })}
      />
    </div>
  );
}

function PlaybookForm({
  c,
  onChange,
}: {
  c: Extract<AuthoredCapability, { kind: 'playbook' }>;
  onChange: (c: AuthoredCapability) => void;
}) {
  const setStep = (i: number, patch: Partial<(typeof c.steps)[number]>) =>
    onChange({ ...c, steps: c.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <div className="flex flex-col gap-3">
      <TextArea
        label="Description"
        value={c.description}
        rows={2}
        onChange={(e) => onChange({ ...c, description: e.target.value })}
      />
      <TextArea
        label="Workflow (workflow.md)"
        value={c.workflow}
        rows={6}
        onChange={(e) => onChange({ ...c, workflow: e.target.value })}
      />
      <fieldset className="flex flex-col gap-2" data-testid="steps">
        <legend className="text-sm font-medium">Steps</legend>
        {c.steps.map((s, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are ordered by position; the name is editable
            key={i}
            className="flex flex-col gap-1 rounded-card border border-line p-2"
          >
            <div className="flex flex-wrap items-end gap-2">
              <span className="pb-2 text-xs text-muted">Step {String(i + 1).padStart(2, '0')}</span>
              <TextInput
                label={`Name of step ${i + 1}`}
                value={s.slug}
                onChange={(e) => setStep(i, { slug: slugOf(e.target.value) })}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={i === 0}
                onClick={() => {
                  const steps = [...c.steps];
                  [steps[i - 1], steps[i]] = [
                    steps[i] as (typeof steps)[number],
                    steps[i - 1] as (typeof steps)[number],
                  ];
                  onChange({ ...c, steps });
                }}
              >
                Up
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onChange({ ...c, steps: c.steps.filter((_, j) => j !== i) })}
              >
                Remove
              </Button>
            </div>
            <TextArea
              label={`Text of step ${i + 1}`}
              value={s.text}
              rows={4}
              onChange={(e) => setStep(i, { text: e.target.value })}
            />
          </div>
        ))}
        <div>
          <Button
            onClick={() =>
              onChange({ ...c, steps: [...c.steps, { slug: `step-${c.steps.length + 1}`, text: '' }] })
            }
          >
            Add a step
          </Button>
        </div>
      </fieldset>
      <FilesEditor prefixes={['assets/']} files={c.files} onChange={(files) => onChange({ ...c, files })} />
    </div>
  );
}

/** Triggers a download of the pack as a zip whose single folder is the pack, ready to `git init` and push. */
export function downloadPackZip(name: string, tree: Record<string, string>): void {
  const bytes = zipTree(tree, name);
  const blob = new Blob(
    [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
    {
      type: 'application/zip',
    },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PackEditor({
  name,
  description,
  initialTree,
  saving,
  canApprove,
  orgVisible,
  onSave,
  onClose,
  extra,
}: {
  name: string;
  description: string;
  initialTree: Record<string, string>;
  saving: boolean;
  /** The author may approve their own organization pack (Owner or Admin). */
  canApprove: boolean;
  orgVisible: boolean;
  onSave: (tree: Record<string, string>, approve: boolean) => void;
  onClose: () => void;
  /** More controls for the side (the agents a private pack is granted to). */
  extra?: React.ReactNode;
}) {
  const loaded = useMemo(() => capabilitiesOfTree(initialTree), [initialTree]);
  const [caps, setCaps] = useState<AuthoredCapability[]>(loaded.caps);
  const [sel, setSel] = useState(0);
  const [approve, setApprove] = useState(false);
  const [adding, setAdding] = useState<AuthoredCapability['kind'] | null>(null);
  const [newKey, setNewKey] = useState('');
  const issues = useMemo(() => validateAuthoredPack(caps), [caps]);
  const errors = authoredHasErrors(issues);
  const current = caps[sel];
  const update = (c: AuthoredCapability) => setCaps(caps.map((x, i) => (i === sel ? c : x)));
  const tree = () => packTree(caps, { name, description });
  return (
    <div className="flex flex-col gap-3" data-testid="pack-editor">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">{name}</h3>
        <Badge>{caps.length} capabilities</Badge>
        <span className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button
          onClick={() => downloadPackZip(name, tree())}
          data-testid="export-zip"
          disabled={caps.length === 0}
        >
          Export as zip
        </Button>
        <Button
          variant="primary"
          loading={saving}
          disabled={errors || caps.length === 0}
          onClick={() => onSave(tree(), approve)}
          data-testid="save-pack"
        >
          Save to workstation
        </Button>
      </div>
      {loaded.issues.length > 0 && (
        <Callout tone="warning">
          Some files in this pack could not be read as capabilities:{' '}
          {loaded.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}
        </Callout>
      )}
      {canApprove && orgVisible && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
          Approve this version myself (I am an Owner or Admin)
        </label>
      )}
      {errors && (
        <Callout tone="danger" role="alert" data-testid="editor-blocked">
          Fix the errors below before saving.
        </Callout>
      )}
      <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-2" data-testid="cap-list">
          <ul className="flex flex-col gap-1">
            {caps.map((c, i) => (
              <li key={`${c.kind}:${c.key}`}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-input border px-2 py-1.5 text-left text-sm ${i === sel ? 'border-accent bg-sunken' : 'border-line'}`}
                  onClick={() => setSel(i)}
                  data-testid={`editor-cap-${c.kind}-${c.key}`}
                >
                  <Badge>{c.kind}</Badge>
                  <span className="truncate">{c.key}</span>
                  {issuesFor(issues, c).some((x) => x.severity === 'error') && (
                    <span className="text-danger" title="has errors">
                      !<span className="sr-only"> has errors</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {adding ? (
            <div className="flex flex-col gap-2 rounded-card border border-line p-2">
              <TextInput
                label={`Key of the new ${adding}`}
                value={newKey}
                onChange={(e) => setNewKey(slugOf(e.target.value))}
                hint="Lowercase letters, digits and hyphens."
              />
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={!newKey || caps.some((c) => c.kind === adding && c.key === newKey)}
                  onClick={() => {
                    setCaps([...caps, blank(adding, newKey)]);
                    setSel(caps.length);
                    setAdding(null);
                    setNewKey('');
                  }}
                >
                  Add
                </Button>
                <Button variant="ghost" onClick={() => setAdding(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {(['skill', 'persona', 'playbook'] as const).map((k) => (
                <Button key={k} size="sm" onClick={() => setAdding(k)} data-testid={`add-${k}`}>
                  Add {k}
                </Button>
              ))}
            </div>
          )}
          {extra}
        </div>
        <div className="min-w-0">
          {!current && <p className="text-sm text-muted">Add a skill, a persona or a playbook to start.</p>}
          {current && (
            <div className="flex flex-col gap-3" data-testid={`editor-${current.kind}`}>
              <div className="flex items-center gap-2">
                <Badge>{current.kind}</Badge>
                <code className="text-sm">{current.key}</code>
                <Button
                  size="sm"
                  variant="danger-ghost"
                  onClick={() => {
                    setCaps(caps.filter((_, i) => i !== sel));
                    setSel(0);
                  }}
                >
                  Delete
                </Button>
              </div>
              {current.kind === 'skill' && <SkillForm c={current} onChange={update} />}
              {current.kind === 'persona' && <PersonaForm c={current} onChange={update} />}
              {current.kind === 'playbook' && <PlaybookForm c={current} onChange={update} />}
              <Issues list={issuesFor(issues, current)} />
            </div>
          )}
          <Issues list={issues.filter((i) => i.path === '.')} />
        </div>
      </div>
    </div>
  );
}
