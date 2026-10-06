/** Card priority as the manager sees it. The API stays numeric (1 = most urgent … 9); these four levels map to it. */
export const PRIORITY_LEVELS = [
  { key: 'urgent', label: 'Urgent', value: 1 },
  { key: 'high', label: 'High', value: 3 },
  { key: 'normal', label: 'Normal', value: 5 },
  { key: 'low', label: 'Low', value: 8 },
] as const;

export type PriorityKey = (typeof PRIORITY_LEVELS)[number]['key'];

export const DEFAULT_PRIORITY = 5;

/** The level nearest to a stored value (ties go to the more urgent level). */
export function priorityLevel(n: number): (typeof PRIORITY_LEVELS)[number] {
  let best: (typeof PRIORITY_LEVELS)[number] = PRIORITY_LEVELS[2];
  let bestD = Number.POSITIVE_INFINITY;
  for (const l of PRIORITY_LEVELS) {
    const d = Math.abs(l.value - n);
    if (d < bestD) {
      best = l;
      bestD = d;
    }
  }
  return best;
}

export const priorityLabel = (n: number): string => priorityLevel(n).label;
