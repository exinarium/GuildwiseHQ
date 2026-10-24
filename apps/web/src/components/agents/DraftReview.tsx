import type { AgentDraft, AgentDraftDto } from '@aom/shared';
import { useEffect, useState } from 'react';
import { useClampDraft } from '../../api/queries/agent-ux.ts';
import { Callout, ErrorBox, Select, TextArea, TextInput } from '../ui.tsx';

const TOOLS: Array<{ id: AgentDraft['tools'][number]; label: string; hint: string }> = [
  { id: 'read', label: 'Read', hint: 'look at files and the card' },
  { id: 'edit', label: 'Edit', hint: 'change files in a worktree' },
  { id: 'shell', label: 'Run commands', hint: 'use the shell' },
  { id: 'web', label: 'Web', hint: 'search and fetch pages' },
];
const MODELS = [
  { id: 'haiku', label: 'Haiku (quick and cheap)' },
  { id: 'sonnet', label: 'Sonnet (most work)' },
  { id: 'opus', label: 'Opus (hard problems)' },
] as const;

/** The draft as the person edits it: the fields of `AgentDraft`, plus what the server says they may grant. */
export type EditedDraft = AgentDraftDto;

/**
 * Review and edit step of a drafted agent (from a described need or from a starter persona). Nothing is hired here: the person
 * edits, then goes on to the normal hire dialog. The permissions shown are always the server's clamp to the person's authority,
 * asked again after every change of the tools.
 */
export function DraftReview({
  draft,
  onChange,
  idPrefix = 'draft',
}: {
  draft: EditedDraft;
  onChange: (d: EditedDraft) => void;
  idPrefix?: string;
}) {
  const clamp = useClampDraft();
  const [stale, setStale] = useState(false);
  // the tools the person ticked; the server answers with what they may have
  const [wanted, setWanted] = useState<AgentDraft['tools']>(draft.tools);
  useEffect(() => setWanted(draft.tools), [draft.tools]);

  const set = (patch: Partial<EditedDraft>) => onChange({ ...draft, ...patch });
  const toggleTool = (t: AgentDraft['tools'][number]) => {
    const next = wanted.includes(t) ? wanted.filter((x) => x !== t) : [...wanted, t];
    const withRead = next.includes('read') ? next : (['read', ...next] as AgentDraft['tools']);
    setWanted(withRead);
    setStale(true);
    clamp.mutate(
      { ...draft, tools: withRead },
      {
        onSuccess: (r) => {
          setStale(false);
          onChange({
            ...draft,
            tools: r.draft.tools,
            permissions: r.draft.permissions,
            withheld: r.draft.withheld,
          });
        },
      },
    );
  };
  // what the draft suggested stays listed when a box is unticked, so it can be ticked again
  const [suggested] = useState({ skills: draft.skills, playbooks: draft.playbooks });
  const granted = new Set(draft.permissions.allowedTools);
  const toggle = (list: string[], k: string) =>
    list.includes(k) ? list.filter((x) => x !== k) : [...list, k];

  return (
    <div className="flex flex-col gap-3" data-testid="draft-review">
      <TextInput
        label="Name"
        id={`${idPrefix}-name`}
        value={draft.name}
        maxLength={60}
        onChange={(e) => set({ name: e.target.value })}
      />
      <TextInput
        label="What it is for"
        id={`${idPrefix}-purpose`}
        value={draft.purpose}
        maxLength={300}
        onChange={(e) => set({ purpose: e.target.value })}
      />
      <TextArea
        label="Instructions"
        id={`${idPrefix}-instructions`}
        rows={8}
        value={draft.instructions}
        maxLength={8000}
        hint="This is what the agent is told every time it works. Edit anything you disagree with."
        onChange={(e) => set({ instructions: e.target.value })}
      />
      <fieldset className="flex flex-col gap-1.5" aria-describedby={`${idPrefix}-tools-hint`}>
        <legend className="text-sm font-medium text-fg">What it may do</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {TOOLS.map((t) => (
            <label key={t.id} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                data-testid={`draft-tool-${t.id}`}
                checked={wanted.includes(t.id)}
                disabled={t.id === 'read'}
                onChange={() => toggleTool(t.id)}
              />
              <span>
                {t.label} <span className="text-subtle">({t.hint})</span>
              </span>
            </label>
          ))}
        </div>
        <p id={`${idPrefix}-tools-hint`} className="text-xs text-subtle" data-testid="draft-granted">
          It will get: {[...granted].join(', ') || 'read'}.{stale ? ' Checking…' : ''}
        </p>
        {draft.withheld.length > 0 && (
          <Callout tone="warning" data-testid="draft-withheld">
            You cannot grant {draft.withheld.join(' or ')}, so the agent will not have{' '}
            {draft.withheld.length === 1 ? 'it' : 'them'}. An Owner or Admin can widen it later.
          </Callout>
        )}
        <ErrorBox error={clamp.error} />
      </fieldset>
      <Select
        label="Model"
        id={`${idPrefix}-model`}
        value={draft.model}
        onChange={(e) => set({ model: e.target.value as AgentDraft['model'] })}
      >
        {MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </Select>
      {(suggested.skills.length > 0 || suggested.playbooks.length > 0) && (
        <div className="flex flex-col gap-1 text-sm" data-testid="draft-suggestions">
          <p className="font-medium text-fg">Suggested</p>
          {suggested.skills.map((k) => (
            <label key={`s-${k}`} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.skills.includes(k)}
                onChange={() => set({ skills: toggle(draft.skills, k) })}
              />
              <span>
                Skill <code>{k}</code>
              </span>
            </label>
          ))}
          {suggested.playbooks.map((k) => (
            <label key={`p-${k}`} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.playbooks.includes(k)}
                onChange={() => set({ playbooks: toggle(draft.playbooks, k) })}
              />
              <span>
                May start the playbook <code>{k}</code>
              </span>
            </label>
          ))}
          <p className="text-xs text-subtle">
            Untick anything you do not want; ticked ones are applied when you hire.
          </p>
        </div>
      )}
    </div>
  );
}
