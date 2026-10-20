import { ArrowUp, Square } from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { cx } from '../ui/cx.ts';

const MAX_ROWS = 8;

/** A touch device types with a software keyboard: Enter is a newline there and the Send button sends. */
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;
}

/** Should this key press send the message? (Enter without Shift, not while composing, not on touch devices.) */
export function enterSends(
  e: { key: string; shiftKey: boolean; isComposing?: boolean },
  touch: boolean,
): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch;
}

/**
 * The message box: auto-sizing (1 to 8 rows), Enter sends on desktop / newline on touch, Stop while the agent answers.
 * The textarea is never disabled while streaming (disabling it closes the on-screen keyboard); only Send is.
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  placeholder = 'Message',
  tools,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  placeholder?: string;
  /** Extra controls on the left of the toolbar (the CEO's model chip). */
  tools?: ReactNode;
  autoFocus?: boolean;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);

  const fit = useCallback(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    const lh = Number.parseFloat(getComputedStyle(el).lineHeight) || 24;
    const max = lh * MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refit when the text changes
  useLayoutEffect(fit, [value, fit]);
  useEffect(() => {
    if (autoFocus && !isTouchDevice()) ta.current?.focus();
  }, [autoFocus]);

  const canSend = !busy && value.trim().length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSend) onSend();
  };
  return (
    <form
      onSubmit={submit}
      aria-label="Compose"
      className="flex shrink-0 flex-col gap-1 rounded-[20px] border border-control bg-surface p-2 shadow-sm focus-within:border-brand focus-within:ring-2 focus-within:ring-ring/25"
    >
      <textarea
        ref={ta}
        aria-label="Message"
        rows={1}
        value={value}
        placeholder={placeholder}
        enterKeyHint={isTouchDevice() ? 'enter' : 'send'}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (enterSends(e.nativeEvent, isTouchDevice())) {
            e.preventDefault();
            if (canSend) onSend();
          }
        }}
        className="max-h-none w-full resize-none bg-transparent px-2 py-1.5 text-base leading-6 text-fg placeholder:text-subtle focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{tools}</div>
        <span className="hidden text-xs text-subtle [@media(pointer:fine)]:sm:block">
          Enter to send · Shift+Enter for a new line
        </span>
        {busy && (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-control bg-surface text-fg hover:bg-sunken md:size-9"
          >
            <Square aria-hidden="true" className="size-4 fill-current" />
          </button>
        )}
        <button
          type="submit"
          aria-label="Send"
          disabled={!canSend}
          className={cx(
            'inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg transition-colors md:size-9',
            'hover:bg-brand-hover disabled:bg-sunken disabled:text-disabled-fg',
          )}
        >
          <ArrowUp aria-hidden="true" className="size-5" />
        </button>
      </div>
    </form>
  );
}
