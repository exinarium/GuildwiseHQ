import { RefreshCw } from 'lucide-react';
import { applyUpdate, useUpdateAvailable } from '../../lib/pwa.ts';

/** A new version of the app is installed and waiting: a small bar above the tab bar offers the reload. */
export function UpdateToast() {
  const available = useUpdateAvailable();
  if (!available) return null;
  return (
    <div
      role="status"
      data-testid="update-toast"
      className="fixed inset-x-0 bottom-[calc(var(--app-bottom-inset,0px)+0.75rem)] z-80 flex justify-center px-4 md:justify-end"
    >
      <div className="flex w-full max-w-sm items-center gap-3 rounded-card border border-line bg-surface p-3 pl-4 shadow-lg">
        <RefreshCw aria-hidden="true" className="size-4 shrink-0 text-info" />
        <p className="min-w-0 flex-1 text-base text-fg">Update available</p>
        <button
          type="button"
          onClick={applyUpdate}
          className="inline-flex h-10 shrink-0 items-center rounded-control bg-brand px-4 text-sm font-semibold text-brand-fg hover:bg-brand-hover"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
