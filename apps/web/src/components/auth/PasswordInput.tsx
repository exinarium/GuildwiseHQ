import { Eye, EyeOff, TriangleAlert } from 'lucide-react';
import { type ComponentProps, useId, useState } from 'react';
import { cx } from '../ui/cx.ts';
import { Field, inputCls } from '../ui.tsx';

/**
 * Password field with a reveal toggle and a Caps Lock hint. The toggle is named "Show characters": its name must
 * never contain the word "password" (getByLabel('Password') must stay unique).
 */
export function PasswordInput({
  label,
  error,
  hint,
  id,
  toggleLabel = '',
  capsHint = false,
  ...rest
}: Omit<ComponentProps<'input'>, 'type'> & {
  label: string;
  error?: string | undefined;
  hint?: string;
  toggleLabel?: string;
  capsHint?: boolean;
}) {
  const auto = useId();
  const fid = id ?? auto;
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const describedBy = [error ? `${fid}-error` : null, capsHint && caps ? `${fid}-caps` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <Field label={label} error={error} hint={hint} htmlFor={fid}>
      <div className="relative">
        <input
          id={fid}
          type={shown ? 'text' : 'password'}
          className={cx(inputCls, 'pr-12')}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          autoCapitalize="none"
          spellCheck={false}
          onKeyUp={(e) => setCaps(e.getModifierState?.('CapsLock') ?? false)}
          onKeyDown={(e) => setCaps(e.getModifierState?.('CapsLock') ?? false)}
          {...rest}
        />
        <button
          type="button"
          aria-pressed={shown}
          aria-label={`${shown ? 'Hide' : 'Show'} characters${toggleLabel}`}
          onClick={() => setShown((s) => !s)}
          className="absolute top-0 right-0 inline-flex h-full min-w-11 items-center justify-center rounded-r-control text-subtle hover:text-fg"
        >
          {shown ? (
            <EyeOff aria-hidden="true" className="size-4" />
          ) : (
            <Eye aria-hidden="true" className="size-4" />
          )}
        </button>
      </div>
      {capsHint && caps && (
        <p id={`${fid}-caps`} role="status" className="flex items-center gap-1.5 text-sm text-warning">
          <TriangleAlert aria-hidden="true" className="size-4" />
          Caps Lock is on
        </p>
      )}
    </Field>
  );
}
