import type { Gate, GateRequire, GateWindow } from '@aom/shared';

/**
 * The rules of a gate in plain sentences (docs/design/environments-ux.md section 9 item 10), the same sentences as the shared
 * `describeGate` of the backend. The web never prints gate field names.
 */

const DAY_NAMES: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export function describeWindow(w: GateWindow): string {
  const days =
    w.days === 'mon-fri'
      ? 'on weekdays'
      : w.days === 'sat,sun' || w.days === 'sat-sun'
        ? 'on weekends'
        : `on ${w.days
            .split(',')
            .map((d) => {
              const [a, b] = d.split('-') as [string, string | undefined];
              return b ? `${DAY_NAMES[a] ?? a} to ${DAY_NAMES[b] ?? b}` : (DAY_NAMES[a] ?? a);
            })
            .join(', ')}`;
  const [from, to] = w.hours.split('-') as [string, string];
  const hh = (h: string) => `${h.padStart(2, '0')}:00`;
  return `Only ${days} between ${hh(from)} and ${hh(to)}${w.tz === 'utc' ? ' (UTC)' : ''}`;
}

const minutesText = (m: number) =>
  m === 1 ? '1 minute' : m % 60 === 0 && m >= 120 ? `${m / 60} hours` : `${m} minutes`;

export function describeGateRequire(r: GateRequire, label: (env: string) => string = (e) => e): string {
  if ('envHealthy' in r) {
    const who = label(r.envHealthy);
    return r.forMinutes
      ? `${who} is healthy on the same version for ${minutesText(r.forMinutes)}`
      : `${who} is running the same version and is healthy`;
  }
  if ('checksPassed' in r) {
    const name =
      r.checksPassed === 'regression'
        ? 'Regression tests'
        : r.checksPassed === 'e2e'
          ? 'End-to-end tests'
          : 'CI checks';
    return `${name} passed for this version`;
  }
  return 'The version is the result of a finished phase';
}

/** One sentence per rule. An empty gate gives an empty list (the caller says "No extra rules"). */
export function describeGate(gate: Gate, label?: (env: string) => string): string[] {
  const out = gate.requires.map((r) => describeGateRequire(r, label));
  if (gate.window) out.push(describeWindow(gate.window));
  if (gate.freeze) out.push('Releases are frozen: nothing goes out until the freeze is lifted');
  return out;
}
