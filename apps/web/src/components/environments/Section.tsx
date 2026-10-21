import { ChevronDown } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { cx } from '../ui.tsx';

const wide = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(min-width: 768px)').matches === true;

/**
 * A titled block of the Environments page. On a phone Places, Rules and History fold into an accordion (`collapsible`); from
 * md up everything is open. The block opens by itself when the address ends in its anchor (`#places`).
 */
export function Section({
  id,
  title,
  sub,
  chip,
  actions,
  collapsible = false,
  testId,
  children,
}: {
  id: string;
  title: string;
  sub?: ReactNode;
  chip?: ReactNode;
  actions?: ReactNode;
  collapsible?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  const labelId = useId();
  const [open, setOpen] = useState(() => !collapsible || wide() || window.location.hash === `#${id}`);
  useEffect(() => {
    const onHash = () => window.location.hash === `#${id}` && setOpen(true);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [id]);
  return (
    <section
      id={id}
      aria-labelledby={labelId}
      data-testid={testId ?? id}
      className="flex scroll-mt-20 flex-col gap-3 rounded-card border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {collapsible ? (
          <h2 className="min-w-0 flex-1 text-sm font-semibold tracking-wide text-fg uppercase" id={labelId}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="flex min-h-11 w-full items-center gap-2 text-left uppercase md:min-h-0 md:cursor-default"
            >
              <ChevronDown
                aria-hidden="true"
                className={cx('size-4 shrink-0 transition-transform md:hidden', !open && '-rotate-90')}
              />
              {title}
            </button>
          </h2>
        ) : (
          <h2 className="min-w-0 flex-1 text-sm font-semibold tracking-wide text-fg uppercase" id={labelId}>
            {title}
          </h2>
        )}
        {chip}
        {actions && open && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {open && (
        <>
          {sub && <p className="-mt-1 text-sm text-muted">{sub}</p>}
          {children}
        </>
      )}
    </section>
  );
}
