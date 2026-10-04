import { type InputHTMLAttributes, useEffect, useRef, useState } from 'react';
import { splitList } from '../../lib/designer.ts';
import { TextInput } from '../ui.tsx';

/**
 * A text input for a list (`a, b` or one per line). It keeps what is being typed (a trailing comma, a half-written
 * `workflow.stage`) and only reports the parsed list, so the field is not rewritten under the cursor.
 */
export function ListInput<T = string>({
  value,
  onChange,
  parse = splitList as unknown as (s: string) => T[],
  format = (v: T[]) => v.join(', '),
  label,
  hint,
  bare = false,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: T[];
  onChange: (v: T[]) => void;
  parse?: (s: string) => T[];
  format?: (v: T[]) => string;
  label?: string;
  hint?: string;
  /** A plain input (table cells): the label is the aria-label. */
  bare?: boolean;
}) {
  const [raw, setRaw] = useState(() => format(value));
  const last = useRef(format(value));
  useEffect(() => {
    const now = format(value);
    if (now !== last.current) {
      last.current = now;
      setRaw(now);
    }
  }, [value, format]);
  const handle = (text: string) => {
    setRaw(text);
    const next = parse(text);
    last.current = format(next);
    onChange(next);
  };
  if (bare) {
    return (
      <input
        className="w-32 rounded border border-zinc-300 px-1.5 py-1 dark:border-zinc-700 dark:bg-zinc-900"
        {...rest}
        value={raw}
        onChange={(e) => handle(e.target.value)}
      />
    );
  }
  return (
    <TextInput
      label={label ?? ''}
      hint={hint}
      {...rest}
      value={raw}
      onChange={(e) => handle(e.target.value)}
    />
  );
}
