import { CHANGE_GROUP_TITLES, type ChangeGroup } from '@aom/shared';
import { Check, CircleHelp, CircleSlash, ListOrdered, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../ui.tsx';

interface Item {
  group: ChangeGroup;
  text: string;
  env?: string;
}

const GROUPS: Array<{ group: ChangeGroup; icon: ReactNode; box: string }> = [
  {
    group: 'question',
    icon: <CircleHelp aria-hidden="true" className="size-4" />,
    box: 'border-warning-fill/50 bg-warning-soft text-warning-soft-fg',
  },
  {
    group: 'setup_once',
    icon: <TriangleAlert aria-hidden="true" className="size-4" />,
    box: 'border-danger-fill/40 bg-danger-soft text-danger-soft-fg',
  },
  {
    group: 'reuse',
    icon: <Check aria-hidden="true" className="size-4" />,
    box: 'border-success-fill/40 bg-success-soft text-success-soft-fg',
  },
  {
    group: 'each_deploy',
    icon: <ListOrdered aria-hidden="true" className="size-4" />,
    box: 'border-info-fill/40 bg-info-soft text-info-soft-fg',
  },
  {
    group: 'untouched',
    icon: <CircleSlash aria-hidden="true" className="size-4" />,
    box: 'border-line bg-sunken text-muted',
  },
];

/**
 * "Found / Each update will / Will not be touched" (design section 3.2 D3): the output of `planChanges`, in plain words, the same
 * on the wizard page, the review and the approval. Technical references stay out; the list is the promise of what changes.
 */
export function FoundChanges({ items, showEnv = false }: { items: Item[]; showEnv?: boolean }) {
  return (
    <div className="flex flex-col gap-3" data-testid="found-changes">
      {GROUPS.map(({ group, icon, box }) => {
        const list = items.filter((i) => i.group === group);
        if (list.length === 0) return null;
        return (
          <section
            key={group}
            aria-label={CHANGE_GROUP_TITLES[group]}
            className={cx('rounded-control border p-3 text-sm', box)}
            data-testid={`changes-${group}`}
          >
            <h4 className="mb-1.5 flex items-center gap-1.5 font-semibold">
              {icon}
              {CHANGE_GROUP_TITLES[group]}
            </h4>
            <ul className="flex flex-col gap-1">
              {list.map((i, n) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the same sentence can appear twice
                <li key={`${i.env}-${i.text}-${n}`} className="[overflow-wrap:anywhere]">
                  {showEnv && i.env ? <span className="font-medium">{i.env}: </span> : null}
                  {i.text}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
