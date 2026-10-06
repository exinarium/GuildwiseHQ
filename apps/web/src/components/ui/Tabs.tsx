import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { cx } from './cx.ts';

export interface TabDef {
  id: string;
  label: string;
  badge?: ReactNode;
}

export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const panelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

/**
 * An accessible tab list (roving tabindex, arrows/Home/End). The caller renders the panel:
 * `<div role="tabpanel" id={panelId(prefix, value)} aria-labelledby={tabId(prefix, value)}>`.
 */
export function Tabs({
  label,
  prefix,
  tabs,
  value,
  onChange,
  className,
}: {
  label: string;
  prefix: string;
  tabs: TabDef[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (e: KeyboardEvent, i: number) => {
    const n = tabs.length;
    let to = -1;
    if (e.key === 'ArrowRight') to = (i + 1) % n;
    else if (e.key === 'ArrowLeft') to = (i - 1 + n) % n;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = n - 1;
    if (to < 0) return;
    e.preventDefault();
    const t = tabs[to];
    if (!t) return;
    onChange(t.id);
    refs.current[t.id]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx(
        'scroll-fade-x -mx-4 mb-5 flex overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0',
        className,
      )}
    >
      {tabs.map((t, i) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={tabId(prefix, t.id)}
            aria-selected={active}
            aria-controls={panelId(prefix, t.id)}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => move(e, i)}
            className={cx(
              '-mb-px inline-flex h-11 shrink-0 items-center gap-2 border-b-2 px-3.5 text-sm font-medium whitespace-nowrap transition-colors',
              active ? 'border-brand text-fg' : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {t.label}
            {t.badge}
          </button>
        );
      })}
    </div>
  );
}
