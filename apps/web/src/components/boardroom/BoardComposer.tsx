import type { BoardCastDto } from '@aom/shared';
import { completeMention, mentionMatches, mentionPartial } from '../../lib/boardroom.ts';
import { Composer } from '../chat/Composer.tsx';

/** The owner's message box with @mention autocomplete: anyone mentioned speaks in the next round. */
export function BoardComposer({
  value,
  onChange,
  onSend,
  cast,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  cast: readonly BoardCastDto[];
  placeholder: string;
  disabled?: boolean;
}) {
  const partial = mentionPartial(value);
  const options = partial === null ? [] : mentionMatches(partial, cast);
  return (
    <div className="flex flex-col gap-1.5">
      {options.length > 0 && (
        <ul
          aria-label="Mention a seat"
          data-testid="mention-list"
          className="flex flex-wrap gap-1.5 rounded-control border border-line bg-surface p-1.5"
        >
          {options.map((o) => (
            <li key={o.slug}>
              <button
                type="button"
                data-testid={`mention-${o.slug}`}
                onClick={() => onChange(completeMention(value, o.slug))}
                className="min-h-8 rounded-full bg-sunken px-3 text-sm text-fg hover:bg-brand-soft hover:text-brand-soft-fg [@media(pointer:coarse)]:min-h-11"
              >
                @{o.slug}
                <span className="ml-1.5 text-xs text-subtle">{o.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Composer
        value={value}
        onChange={onChange}
        onSend={() => !disabled && onSend()}
        onStop={() => undefined}
        busy={false}
        placeholder={placeholder}
        slash={{ context: 'session' }}
      />
    </div>
  );
}
