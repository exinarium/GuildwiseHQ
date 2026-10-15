import type { ProjectDto } from '@aom/shared';
import { Callout } from './ui.tsx';

/** "18:00", or "Thu 22 Oct 18:00" when the reset is not today; in the viewer's own time zone. */
export function formatUntil(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${hm}`;
}

/**
 * Backlog #73: the model subscription's usage limit was hit on the workstation(s) that run this project. Work is paused,
 * not failed, and resumes by itself; nothing for the viewer to do.
 */
export function UsageLimitBanner({ limit }: { limit: ProjectDto['usageLimit'] }) {
  if (!limit) return null;
  return (
    <Callout
      tone="warning"
      role="status"
      data-testid="usage-limit-banner"
      title={`Paused until ${formatUntil(limit.until)} (usage limit on ${limit.workstationName})`}
      className="mb-3"
    >
      The Claude subscription behind this project hit its usage limit. Cards stay in the queue without penalty
      and work resumes by itself when the limit resets.
    </Callout>
  );
}
