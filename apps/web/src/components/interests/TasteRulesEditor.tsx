import { useState } from 'react';
import { Button, TextInput } from '../ui.tsx';

/** A list of explicit taste rules (one sentence each): add, edit in place, remove. Shared by the drawer and the project panel. */
export function TasteRulesEditor({
  rules,
  onChange,
  disabled,
  testId = 'taste-rules',
}: {
  rules: string[];
  onChange: (rules: string[]) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const text = draft.replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (!rules.some((r) => r.toLowerCase() === text.toLowerCase())) onChange([...rules, text]);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {rules.length === 0 && <p className="text-xs text-zinc-500">No explicit rules yet.</p>}
      <ul className="flex flex-col gap-1">
        {rules.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rules are edited in place, so their position is their identity
          <li key={i} className="flex items-center gap-2" data-testid="taste-rule">
            <input
              aria-label={`Rule ${i + 1}`}
              className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900"
              value={r}
              disabled={disabled}
              onChange={(e) => onChange(rules.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <Button
              aria-label={`Remove rule ${i + 1}`}
              disabled={disabled}
              onClick={() => onChange(rules.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <TextInput
            label="Add a rule"
            hint='A sentence the curators follow first, e.g. Skip beginner tutorials. A rule like skip "Exact title" drops that item.'
            value={draft}
            disabled={disabled}
            data-testid="taste-rule-input"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
        </div>
        <Button disabled={disabled || !draft.trim()} data-testid="taste-rule-add" onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}
