import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { cx } from './cx.ts';

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  action?: { label: string; onClick: () => void } | undefined;
}
interface ToastApi {
  success: (message: string, action?: ToastItem['action']) => void;
  error: (message: string) => void;
  info: (message: string, action?: ToastItem['action']) => void;
}

const Ctx = createContext<ToastApi | null>(null);
const noop: ToastApi = { success: () => undefined, error: () => undefined, info: () => undefined };

/** Toasts after actions. Outside a provider (unit tests) the calls are no-ops. */
export const useToast = (): ToastApi => useContext(Ctx) ?? noop;

const icon = { success: CheckCircle2, error: AlertCircle, info: Info };
const tint = { success: 'text-success', error: 'text-danger', info: 'text-info' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setItems((cur) => cur.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string, action?: ToastItem['action']) => {
      const id = ++seq.current;
      setItems((cur) => [...cur.slice(-2), { id, tone, message, action }]);
      if (tone !== 'error')
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), 5000),
        );
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, a) => push('success', m, a),
      error: (m) => push('error', m),
      info: (m, a) => push('info', m, a),
    }),
    [push],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        data-testid="toasts"
        className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+4rem)] z-80 flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:top-auto sm:right-4 sm:bottom-4 sm:items-end sm:px-0"
      >
        {items.map((t) => {
          const Icon = icon[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              aria-live={t.tone === 'error' ? 'assertive' : 'polite'}
              className="pointer-events-auto flex w-full max-w-sm animate-toast items-start gap-3 rounded-card border border-line bg-surface p-3 pr-2 shadow-lg"
            >
              <Icon aria-hidden="true" className={cx('mt-0.5 size-5 shrink-0', tint[t.tone])} />
              <p className="min-w-0 flex-1 py-px text-base text-fg">{t.message}</p>
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                  className="rounded px-2 py-1 text-sm font-medium text-brand-text hover:bg-sunken"
                >
                  {t.action.label}
                </button>
              )}
              <button
                type="button"
                aria-label="Close notification"
                onClick={() => dismiss(t.id)}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded text-subtle hover:bg-sunken hover:text-fg"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}
