import { MAPPING_TOKENS } from '@aom/shared';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { WizardState } from '../../lib/schedules.ts';
import { Button, TextInput } from '../ui.tsx';

type Row = WizardState['mapping'][number];

/** What each token stands for, in the words of the person filling the card. */
const TOKEN_HELP: Record<string, string> = {
  'card.ref': 'Reference of the card that caused it',
  'card.title': 'Title of that card',
  'issue.title': 'Title of the ticket',
  'issue.key': 'Key of the ticket',
  event: 'What happened, in words',
  date: 'Today, in your time zone',
};

/** Tokens offered here: the e-mail ones belong to the e-mail triggers, which are not available yet. */
export const OFFERED_TOKENS = MAPPING_TOKENS.filter((t) => !t.startsWith('email.'));

/**
 * "Fill the card": which card field gets which text. The text may contain {tokens} of the event; the values are put in
 * as written and never expanded again. The title and the context are the usual targets; any card field key works.
 */
export function MappingEditor({
  rows,
  onChange,
  error,
}: {
  rows: Row[];
  onChange: (rows: Row[]) => void;
  error?: string | undefined;
}) {
  const [active, setActive] = useState(0);
  const update = (i: number, patch: Partial<Row>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const insert = (token: string) => {
    if (rows.length === 0) {
      onChange([{ target: 'title', text: `{${token}}` }]);
      setActive(0);
      return;
    }
    const i = Math.min(active, rows.length - 1);
    const cur = rows[i] as Row;
    update(i, { text: `${cur.text}${cur.text && !cur.text.endsWith(' ') ? ' ' : ''}{${token}}` });
  };

  return (
    <fieldset className="flex flex-col gap-3" data-testid="mapping-editor">
      <legend className="text-sm font-medium text-fg">Fill the card from the event</legend>
      <p className="text-sm text-muted">
        Optional. Without it the card gets the title and fields above. Each line sets one field to a text;
        click a token to add it to the line you are editing.
      </p>
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the lines have no identity of their own and are edited in place
        <div key={i} className="grid gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
          <TextInput
            label="Field"
            list="mapping-targets"
            value={r.target}
            onChange={(e) => update(i, { target: e.target.value })}
            onFocus={() => setActive(i)}
            aria-label={`Field of line ${i + 1}`}
          />
          <TextInput
            label="Text"
            value={r.text}
            onChange={(e) => update(i, { text: e.target.value })}
            onFocus={() => setActive(i)}
            aria-label={`Text of line ${i + 1}`}
            maxLength={2000}
          />
          <Button
            aria-label={`Remove line ${i + 1}`}
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
      ))}
      <datalist id="mapping-targets">
        <option value="title" />
        <option value="context" />
      </datalist>
      <div>
        <Button data-testid="add-mapping" onClick={() => onChange([...rows, { target: 'title', text: '' }])}>
          <Plus aria-hidden="true" className="size-4" />
          Add a line
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger" data-testid="mapping-error">
          {error}
        </p>
      )}
      <div>
        <p className="text-xs font-medium text-subtle">Tokens</p>
        <ul className="mt-1 flex flex-wrap gap-2" aria-label="Tokens" data-testid="mapping-tokens">
          {OFFERED_TOKENS.map((t) => (
            <li key={t}>
              <button
                type="button"
                title={TOKEN_HELP[t] ?? t}
                onClick={() => insert(t)}
                className="rounded-control border border-line bg-surface px-2 py-1 font-mono text-xs text-fg hover:border-control"
              >
                {`{${t}}`}
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-subtle">
          For a card event you can also use {'{card.fields.<name>}'}, for example {'{card.fields.context}'}.
        </p>
      </div>
    </fieldset>
  );
}
