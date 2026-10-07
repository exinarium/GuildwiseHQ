/**
 * Cost tracking and budgets (docs/design/restructure.md, "Roadmap after the restructure").
 *
 * Money is kept as integer micro-units: `usdMicros` (1e-6 USD) for what a shift cost at list prices, and "currency
 * micros" (1e-6 of the organization's currency) for budgets and everything shown to the manager. The conversion is
 * `usdMicros * organizations.usd_rate` (default 1, currency USD).
 */

/** Per-million-token prices in USD for one model family. */
export interface ModelPrice {
  /** Substring matched (case-insensitively) against the agent's free-form model string. */
  match: string;
  label: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * DEFAULT price table: Anthropic's published list prices in USD per million tokens (cache writes at the 5-minute
 * rate, cache reads at 10% of the input price). These are DEFAULTS, not billing data: the real invoice depends on the
 * plan, discounts and batch/priority tiers. The table is deliberately plain data in shared config so the super admin
 * can edit it later (a platform setting that stamps `costMicros` on new `ShiftEnded` events; history keeps the price it
 * was recorded at). Order matters: the first match wins; the last entry is the fallback for an unknown model.
 */
export const DEFAULT_MODEL_PRICES: readonly ModelPrice[] = [
  { match: 'opus', label: 'Opus', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: 'sonnet', label: 'Sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: 'haiku', label: 'Haiku', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // Unknown models (the mock runtime, other providers) are priced like Sonnet so spend is never silently zero.
  { match: '', label: 'Other (priced as Sonnet)', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
];

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function priceFor(model: string, table: readonly ModelPrice[] = DEFAULT_MODEL_PRICES): ModelPrice {
  const m = model.toLowerCase();
  return (
    table.find((p) => p.match !== '' && m.includes(p.match)) ??
    (table[table.length - 1] as ModelPrice) ??
    (DEFAULT_MODEL_PRICES[DEFAULT_MODEL_PRICES.length - 1] as ModelPrice)
  );
}

/** The family label a model rolls up under in the cost breakdown ("Opus", "Sonnet", ...). */
export const modelFamily = (model: string, table: readonly ModelPrice[] = DEFAULT_MODEL_PRICES): string =>
  priceFor(model, table).label;

/** Micro-USD for one shift: tokens times the per-million price (the units cancel: $/Mtok x tokens = micro-USD). */
export function costUsdMicros(
  model: string,
  usage: TokenCounts,
  table: readonly ModelPrice[] = DEFAULT_MODEL_PRICES,
): number {
  const p = priceFor(model, table);
  // Integer arithmetic in hundredths of a micro-USD so the result is exact (and equals the SQL backfill's numeric math).
  const c = (price: number) => Math.round(price * 100);
  const total =
    usage.inputTokens * c(p.input) +
    usage.outputTokens * c(p.output) +
    (usage.cacheReadTokens ?? 0) * c(p.cacheRead) +
    (usage.cacheWriteTokens ?? 0) * c(p.cacheWrite);
  return Math.floor((total + 50) / 100);
}

export const DEFAULT_CURRENCY = 'USD';

/** Where a spend that belongs to no project (chats without a card, the BA's org-level work) is rolled up. */
export const OVERHEAD_LABEL = 'Org overhead';

/** Budget thresholds, in percent of the monthly budget (owner requirement). */
export const BUDGET = { warnPercent: 80, pausePercent: 100 } as const;

export type BudgetState = 'none' | 'ok' | 'warning' | 'paused' | 'overridden';

/**
 * Where a project's month stands. `budget` and `spend` are in the same unit. A project over 100% is `paused` (its
 * dispatching stops) unless the manager overrode it for this month. No budget: `none`.
 */
export function budgetStatus(
  budget: number | null | undefined,
  spend: number,
  overridden = false,
): { state: BudgetState; percent: number | null } {
  if (budget === null || budget === undefined || budget <= 0) return { state: 'none', percent: null };
  const percent = (spend / budget) * 100;
  if (percent >= BUDGET.pausePercent) return { state: overridden ? 'overridden' : 'paused', percent };
  if (percent >= BUDGET.warnPercent) return { state: 'warning', percent };
  return { state: 'ok', percent };
}

// ------------------------------------------------------------------------------------------ month maths

/** `YYYY-MM` of `date` in the organization's time zone (UTC when unknown). */
export function monthKeyOf(date: Date, timeZone: string | null | undefined): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}`;
}

/** How far the zone is ahead of UTC at that instant, in ms (whole minutes). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return asUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

/** The instant at which local time in `timeZone` reads `year-month-day 00:00` (month is 1-12). */
function localStartUtc(year: number, month: number, day: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const next = wall - zoneOffsetMs(new Date(guess), timeZone);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

const safeZone = (tz: string | null | undefined): string => {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
};

/** The first instant of the month `date` falls in, in the organization's time zone. */
export function monthStartOf(date: Date, timeZone: string | null | undefined): Date {
  const [y, m] = monthKeyOf(date, timeZone).split('-').map(Number) as [number, number];
  return localStartUtc(y, m, 1, safeZone(timeZone));
}

/** The first instant of the local calendar day `YYYY-MM-DD` in the zone. */
export function zonedDayStart(ymd: string, timeZone: string | null | undefined): Date {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return localStartUtc(y, m, d, safeZone(timeZone));
}

/** The calendar day after `YYYY-MM-DD` (pure date arithmetic, no zone). */
export function nextDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** The first instant of the next month: when the budget resets. */
export function nextMonthStartOf(date: Date, timeZone: string | null | undefined): Date {
  const [y, m] = monthKeyOf(date, timeZone).split('-').map(Number) as [number, number];
  return m === 12
    ? localStartUtc(y + 1, 1, 1, safeZone(timeZone))
    : localStartUtc(y, m + 1, 1, safeZone(timeZone));
}

// ------------------------------------------------------------------------------------------ money

/** Whole currency units to micro-units and back (budgets are typed in whole units with cents). */
export const toMicros = (units: number): number => Math.round(units * 1_000_000);
export const fromMicros = (micros: number): number => micros / 1_000_000;

/** `$12.34` style text; falls back to `CODE 12.34` for a currency Intl does not know. */
export function formatMoney(micros: number, currency: string = DEFAULT_CURRENCY): string {
  const units = micros / 1_000_000;
  // Small amounts keep their precision (a mock shift costs fractions of a cent); large ones drop the cents.
  const abs = Math.abs(units);
  const digits = abs < 1 && abs > 0 ? 3 : abs < 100 ? 2 : 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(units);
  } catch {
    return `${currency} ${units.toFixed(digits)}`;
  }
}

export const COST_CSV_COLUMNS = [
  'date',
  'project',
  'agent',
  'model',
  'shifts',
  'input',
  'output',
  'cache_read',
  'cache_write',
  'cost',
] as const;
