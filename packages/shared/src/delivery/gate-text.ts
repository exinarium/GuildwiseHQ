import type { Gate, GateRequire, GateWindow } from './gate.ts';

/**
 * The rules of a gate in plain sentences (docs/design/environments-ux.md section 9 item 10). Used by the Environments
 * page, the Releases page and the Review dialog; the web must not print gate field names.
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

export function describeGateRequire(r: GateRequire, label: (env: string) => string = (e) => e): string {
  if ('envHealthy' in r) {
    const who = label(r.envHealthy);
    return r.forMinutes
      ? `${who} is healthy on the same version for ${r.forMinutes === 1 ? '1 minute' : r.forMinutes % 60 === 0 && r.forMinutes >= 120 ? `${r.forMinutes / 60} hours` : `${r.forMinutes} minutes`}`
      : `${who} is running the same version and is healthy`;
  }
  if ('checksPassed' in r) {
    const name = r.checksPassed === 'regression' ? 'Regression tests' : r.checksPassed === 'e2e' ? 'End-to-end tests' : 'CI checks';
    return `${name} passed for this version`;
  }
  return 'The version is the result of a finished phase';
}

/**
 * One sentence per rule, in the order a person reads them. An empty gate gives an empty list (the caller says "No extra
 * rules"). `releasedBy` is not part of a gate; the caller adds "You approve every release" itself.
 */
export function describeGate(gate: Gate | 'none' | string, label?: (env: string) => string): string[] {
  if (typeof gate === 'string') return gate === 'none' ? [] : [`Uses the rule set "${gate}"`];
  const out = gate.requires.map((r) => describeGateRequire(r, label));
  if (gate.window) out.push(describeWindow(gate.window));
  if (gate.freeze) out.push('Releases are frozen: nothing goes out until the freeze is lifted');
  return out;
}
