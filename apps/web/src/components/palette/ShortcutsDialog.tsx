import { SHORTCUTS } from '../../lib/shortcuts.ts';
import { Dialog } from '../ui.tsx';

const GROUPS = ['General', 'Go to', 'Create'] as const;

/** The `?` dialog: every keyboard shortcut. */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      description="Single keys work when you are not typing in a field."
    >
      <div className="flex flex-col gap-5" data-testid="shortcuts-dialog">
        {GROUPS.map((g) => (
          <section key={g} aria-label={g}>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-subtle uppercase">{g}</h3>
            <ul className="flex flex-col divide-y divide-line">
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <li key={s.label} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <span className="text-fg">{s.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {s.keys.map((k, i) => (
                      <span key={k} className="flex items-center gap-1">
                        {i > 0 && <span className="text-xs text-subtle">then</span>}
                        <kbd className="min-w-6 rounded-[6px] border border-control bg-sunken px-1.5 py-0.5 text-center font-mono text-xs text-fg">
                          {k}
                        </kbd>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
