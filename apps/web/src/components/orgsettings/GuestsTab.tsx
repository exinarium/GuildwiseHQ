import { Users } from 'lucide-react';
import { useOrgGuests } from '../../api/queries/orgs.ts';
import { formatDateTime } from '../../lib/time.ts';
import { UserAvatar } from '../Face.tsx';
import { EmptyState, ErrorBox, ListSkeleton, Panel } from '../ui.tsx';

/** People who work on projects of the organization without being members of it (guests do not count against limits). */
export function GuestsTab() {
  const guests = useOrgGuests();
  return (
    <Panel title="Guests" padding="none">
      {guests.isPending && (
        <div className="p-4">
          <ListSkeleton label="Loading guests" rows={2} />
        </div>
      )}
      {guests.data?.length === 0 && (
        <EmptyState
          bare
          icon={Users}
          title="No guests"
          description="A guest is someone who belongs to another organization and works on one of your projects. Share a project from its settings to add one."
        />
      )}
      <ul className="divide-y divide-line text-sm" data-testid="guests">
        {guests.data?.map((g) => (
          <li key={g.userId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
            <UserAvatar user={{ id: g.userId, displayName: g.displayName }} size={32} />
            <div className="min-w-[10rem] flex-1">
              <p className="font-medium text-fg">{g.displayName}</p>
              <p className="truncate text-xs text-subtle">{g.email}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {g.projects.map((p) => (
                <span
                  key={p.id}
                  title={p.name}
                  className="rounded-[6px] bg-neutral-soft px-1.5 font-mono text-xs font-semibold text-neutral-soft-fg"
                >
                  {p.key}
                </span>
              ))}
            </div>
            <p className="w-32 text-xs text-subtle">
              {g.since ? `since ${formatDateTime(g.since).split(',')[0]}` : ''}
            </p>
          </li>
        ))}
      </ul>
      <div className="px-4 pb-3 empty:hidden">
        <ErrorBox error={guests.error} />
      </div>
    </Panel>
  );
}
