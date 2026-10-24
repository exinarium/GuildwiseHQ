import { type MentionableAgentDto, mentionQueryAt } from '@aom/shared';
import { type KeyboardEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../ui/cx.ts';
import { inputCls } from '../ui.tsx';

/**
 * The card comment box with @agent autocomplete. Typing `@` offers the agents the person may mention on this card (the
 * server decides who, see `GET /api/cards/:id/mentionable`); Enter or Tab inserts `@handle `, Escape closes the list.
 * An agent named in a comment is asked a small, read-only question about the card and answers in the thread.
 */
export function MentionBox({
  label,
  value,
  onChange,
  agents,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  agents: readonly MentionableAgentDto[];
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const q = mentionQueryAt(value, caret);
  const matches = useMemo(
    () =>
      q && agents.length
        ? agents
            .filter((a) => a.handle.startsWith(q.query) || a.name.toLowerCase().startsWith(q.query))
            .slice(0, 6)
        : [],
    [agents, q],
  );
  const open = !!q && matches.length > 0 && closedAt !== q.start;
  const at = Math.min(active, Math.max(0, matches.length - 1));

  // the caret goes after the inserted handle once the new text is in the box
  const nextCaret = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the text changes
  useLayoutEffect(() => {
    const pos = nextCaret.current;
    if (pos === null || !ref.current) return;
    nextCaret.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(pos, pos);
  }, [value]);
  const pick = (a: MentionableAgentDto) => {
    if (!q) return;
    const next = `${value.slice(0, q.start)}@${a.handle} ${value.slice(caret)}`;
    const pos = q.start + a.handle.length + 2;
    nextCaret.current = pos;
    onChange(next);
    setCaret(pos);
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((at + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const m = matches[at];
      if (m) pick(m);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setClosedAt(q?.start ?? null);
    }
  };

  return (
    <div className="relative flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </label>
      <textarea
        id={id}
        ref={ref}
        rows={3}
        value={value}
        className={cx(inputCls, 'resize-y')}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${id}-opt-${at}` : undefined}
        aria-describedby={agents.length ? `${id}-hint` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setClosedAt(null);
        }}
        onKeyDown={keys}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
      />
      {agents.length > 0 && (
        <p id={`${id}-hint`} className="text-xs text-subtle">
          Type @ to ask an agent a small question about this card. It reads and answers here; it does not
          change anything.
        </p>
      )}
      {open && (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label="Agents you can mention"
          data-testid="mention-list"
          className="absolute left-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-control border border-control bg-surface shadow-lg"
        >
          {matches.map((a, i) => (
            <div
              key={a.agentId}
              tabIndex={-1}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === at}
              data-testid={`mention-option-${a.handle}`}
              className={cx('cursor-pointer px-3 py-1.5 text-sm', i === at ? 'bg-sunken' : '')}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(a);
              }}
            >
              <span className="font-medium">{a.name}</span> <span className="text-subtle">@{a.handle}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
