import type { WorkstationDto } from '@aom/shared';
import { Badge } from '../ui.tsx';

type Update = NonNullable<WorkstationDto['runnerUpdate']>;

/** How a runner's self-update is shown on the Workstations page. Null when there is nothing to say (up to date, or an old runner). */
export function updateLabel(
  u: Update,
): { text: string; tone: 'info' | 'warning' | 'danger' | 'neutral' } | null {
  const to = u.latestVersion ? ` to ${u.latestVersion}` : '';
  switch (u.state) {
    case 'up_to_date':
      return null;
    case 'pending':
      return { text: `Update${to} pending`, tone: 'info' };
    case 'updating':
      return { text: `Updating${to}`, tone: 'info' };
    case 'failed':
      return { text: 'Update failed', tone: 'danger' };
    case 'rolled_back':
      return { text: 'Update rolled back', tone: 'warning' };
    case 'paused':
      return { text: 'Updates paused', tone: 'neutral' };
    case 'unmanaged':
      return { text: 'Updates by hand', tone: 'neutral' };
  }
}

export function RunnerUpdateBadge({ update }: { update: WorkstationDto['runnerUpdate'] }) {
  if (!update) return null;
  const label = updateLabel(update);
  if (!label) return null;
  const checked = update.lastCheckedAt
    ? ` Last checked ${new Date(update.lastCheckedAt).toLocaleString()}.`
    : '';
  return (
    <Badge tone={label.tone} title={`${update.detail ?? label.text}.${checked}`} data-testid="runner-update">
      {label.text}
    </Badge>
  );
}
