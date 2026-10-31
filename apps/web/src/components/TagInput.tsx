import { DOCUMENT_MAX_TAGS, normalizeDocumentTag } from '@aom/shared';
import { X } from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';
import { inputCls } from './ui.tsx';

/**
 * Tags as chips: Enter or a comma adds the typed tag (it is normalized the way the server stores it), the remove
 * buttons and the field are touch-sized, and the field asks the soft keyboard for a plain "done" key.
 */
export function TagInput({
  tags,
  onChange,
  label = 'Tags',
  suggestions = [],
  disabled,
}: {
  tags: string[];
  onChange: (t: string[]) => void;
  label?: string;
  suggestions?: string[];
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const id = useId();
  const add = (raw: string) => {
    const t = normalizeDocumentTag(raw);
    setDraft('');
    if (!t || tags.includes(t) || tags.length >= DOCUMENT_MAX_TAGS) return;
    onChange([...tags, t]);
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
  };
  const listId = `${id}-suggestions`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </label>
      {tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected tags">
          {tags.map((t) => (
            <li
              key={t}
              className="inline-flex items-center gap-1 rounded-full bg-sunken py-0.5 pr-0.5 pl-3 text-sm text-fg"
            >
              {t}
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove tag ${t}`}
                onClick={() => onChange(tags.filter((x) => x !== t))}
                className="inline-flex size-9 items-center justify-center rounded-full text-muted hover:bg-line hover:text-fg [@media(pointer:coarse)]:size-11"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={id}
        type="text"
        value={draft}
        disabled={disabled || tags.length >= DOCUMENT_MAX_TAGS}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={key}
        onBlur={() => add(draft)}
        enterKeyHint="done"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        list={suggestions.length ? listId : undefined}
        placeholder="Add a tag, then press Enter"
        className={inputCls}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions
            .filter((s) => !tags.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      )}
      <p className="text-xs text-subtle">
        Lowercase words; up to {DOCUMENT_MAX_TAGS} tags. Press Enter or a comma to add one.
      </p>
    </div>
  );
}
