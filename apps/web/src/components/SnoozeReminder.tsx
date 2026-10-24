import type { DeskItemDto } from '@aom/shared';
import { useSnoozeDeskItem } from '../api/queries/agent-ux.ts';
import { formatDateTime } from '../lib/time.ts';
import { Badge, Menu, MenuItem, useToast } from './ui.tsx';

const OPTIONS = [
  { days: 1, label: '1 day' },
  { days: 3, label: '3 days' },
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
] as const;

/** What the chase has done to an open item ("Reminded", "Snoozed until ...") and the control that snoozes its next reminder. */
export function ReminderBadges({ item }: { item: DeskItemDto }) {
  const f = item.followUp;
  const snoozed = f?.snoozedUntil && new Date(f.snoozedUntil).getTime() > Date.now();
  if (!f?.nudgeCount && !snoozed) return null;
  return (
    <>
      {f?.nudgeCount ? (
        <Badge tone="amber" title={f.nudgedAt ? `Last reminder ${formatDateTime(f.nudgedAt)}` : undefined}>
          <span data-testid="reminded-badge">Reminded{f.nudgeCount > 1 ? ` x${f.nudgeCount}` : ''}</span>
        </Badge>
      ) : null}
      {snoozed && f?.snoozedUntil ? (
        <Badge tone="neutral" title="No reminder before then">
          <span data-testid="snoozed-badge">Snoozed until {formatDateTime(f.snoozedUntil)}</span>
        </Badge>
      ) : null}
    </>
  );
}

export function SnoozeSelect({ item }: { item: DeskItemDto }) {
  const snooze = useSnoozeDeskItem();
  const toast = useToast();
  if (item.status !== 'open' || !item.canAnswer) return null;
  return (
    <Menu
      label={`Snooze reminders for ${item.title}`}
      trigger={<span className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-sunken">Snooze</span>}
    >
      {OPTIONS.map((o) => (
        <MenuItem
          key={o.days}
          onSelect={() =>
            snooze.mutate(
              { id: item.id, days: o.days },
              {
                onSuccess: () =>
                  toast.success(`No reminder for ${o.days === 1 ? 'a day' : `${o.days} days`}`),
              },
            )
          }
        >
          {o.label}
        </MenuItem>
      ))}
    </Menu>
  );
}
