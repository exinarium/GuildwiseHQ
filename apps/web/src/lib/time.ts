export function ageLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '';
}

export function formatDate(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
    : '';
}

/** A calendar date (YYYY-MM-DD) as text. Read in UTC so the day does not shift in a time zone behind UTC. */
export function formatCalendarDate(d: string | null | undefined): string {
  return d
    ? new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '';
}
