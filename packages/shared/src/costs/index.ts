import { codexPrice, isCodexModel } from '../models/codex.ts';
import { directPrice, splitDirectModel } from '../models/direct.ts';

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
  /** Cache write at the 5-minute rate (1.25x the input price). */
  cacheWrite: number;
  /** Cache write at the 1-hour rate (2x the input price): Claude Code writes 1-hour caches unless told otherwise. */
  cacheWrite1h: number;
}

/**
 * DEFAULT price table: Anthropic's list prices in USD per million tokens as of October 2026 (cache writes at the
 * 5-minute rate, 1.25x the input price, or at the 1-hour rate, 2x, when the usage says how many tokens were written with
 * the longer TTL; cache reads at 10% of the input price, 5% on Opus 5.5, Sonnet 5.5 and Fable 5.1). Checked against
 * platform.claude.com/docs/en/about-claude/pricing on 18 Oct 2026. Haiku 5.5 doubles its price ($0.50 / $2.50) for a
 * request over 100K prompt tokens; usage arrives per shift, not per request, so the table uses the lower tier and can
 * under-count Haiku shifts with very large prompts.
 * These are DEFAULTS, not billing data: the real invoice depends on the plan, discounts and batch/priority tiers.
 * The table is deliberately plain data in shared config so the super admin can edit it later. The server stamps
 * `costMicros` (priced with the table as it is at that moment) on every `ShiftEnded` and `ShiftUsageRecorded` event it
 * appends, and the projection uses a stamped price as is: changing this table reprices only shifts recorded afterwards.
 * Events from before stamping existed carry no price and are priced from this table on every replay, so a change here
 * moves their history.
 * Models are mapped by family (fable, opus, sonnet, haiku). Order matters: the first match wins; the last entry is the
 * fallback for an unknown model. The SQL in migration 1318 mirrors this table.
 */
export const DEFAULT_MODEL_PRICES: readonly ModelPrice[] = [
  {
    match: 'fable-5-1',
    label: 'Fable',
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
    cacheWrite1h: 20,
  },
  { match: 'fable', label: 'Fable', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
  // Opus 5.5 is cheaper than the earlier Opus models ($4 / $20, cache reads $0.20); the plain `opus` alias stays at the
  // earlier price so spend is never under-counted when the alias points at an older Opus.
  { match: 'opus-5-5', label: 'Opus', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  { match: 'opus', label: 'Opus', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  // Sonnet 5.5 and 5 are $2 / $10; cache reads are $0.10 on 5.5 and $0.20 on 5. Sonnet 4.x is $3 / $15.
  {
    match: 'sonnet-5-5',
    label: 'Sonnet',
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    cacheWrite1h: 4,
  },
  {
    match: 'sonnet-4',
    label: 'Sonnet',
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
  },
  {
    match: 'sonnet',
    label: 'Sonnet',
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    cacheWrite1h: 4,
  },
  {
    match: 'haiku-5',
    label: 'Haiku',
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    cacheWrite1h: 0.2,
  },
  { match: 'haiku', label: 'Haiku', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
  // Unknown models (the mock runtime, other providers) are priced like Sonnet so spend is never silently zero.
  {
    match: '',
    label: 'Other (priced as Sonnet)',
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    cacheWrite1h: 4,
  },
];

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Of `cacheWriteTokens`, the ones written with the 1-hour TTL (priced at `cacheWrite1h`); the rest are 5-minute writes. */
  cacheWrite1hTokens?: number;
}

/** A price the organization's Owner set for a model the built-in tables do not know (USD per million tokens). */
export interface OwnerModelPrice {
  provider: string;
  model: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok?: number | null;
}

/** The Owner's price for `provider:model` (exact id), if there is one. */
export function ownerPriceOf(
  model: string,
  owner: readonly OwnerModelPrice[] | undefined,
): { input: number; output: number; cacheRead?: number } | undefined {
  if (!owner?.length) return undefined;
  const d = splitDirectModel(model);
  if (!d) return undefined;
  const hit = owner.find((o) => o.provider === d.provider && o.model === d.model);
  return hit
    ? {
        input: hit.inputPerMtok,
        output: hit.outputPerMtok,
        ...(hit.cacheReadPerMtok != null ? { cacheRead: hit.cacheReadPerMtok } : {}),
      }
    : undefined;
}

/** True when the cost of `model` comes from an Owner-set price: the built-in tables have none and the Owner entered one. */
export function isOwnerPriced(
  model: string,
  owner: readonly OwnerModelPrice[] | undefined,
  table: readonly ModelPrice[] = DEFAULT_MODEL_PRICES,
): boolean {
  return directPriceOf(model, table) === null && ownerPriceOf(model, owner) !== undefined;
}

/** The price of a model of the direct-model runtime (`provider:model`): undefined for any other model, null when unknown. */
function directPriceOf(
  model: string,
  table: readonly ModelPrice[],
  owner?: readonly OwnerModelPrice[],
): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null | undefined {
  const built = builtinDirectPriceOf(model, table);
  // The Owner's table fills gaps only: a model with a list price keeps it.
  return built === null ? (ownerPriceOf(model, owner) ?? null) : built;
}

function builtinDirectPriceOf(
  model: string,
  table: readonly ModelPrice[],
): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null | undefined {
  // A Codex CLI model: its own (empty) price table, never a Claude price.
  if (isCodexModel(model)) return codexPrice(model);
  // The Gemini CLI reports `gemini:<model>`: Google's list prices when the table has the model, else unknown.
  if (model.startsWith('gemini:')) return directPrice('google', model.slice('gemini:'.length));
  // opencode reports `opencode:<provider>/<model>`: the provider's table (Anthropic models from the Claude table), else unknown.
  if (model.startsWith('opencode:')) {
    const rest = model.slice('opencode:'.length);
    const i = rest.indexOf('/');
    const provider = i > 0 ? rest.slice(0, i) : '';
    const name = i > 0 ? rest.slice(i + 1) : rest;
    return directPrice(provider, name, (m) => {
      const lower = m.toLowerCase();
      const hit = table.find((x) => x.match !== '' && lower.includes(x.match));
      return hit
        ? { input: hit.input, output: hit.output, cacheRead: hit.cacheRead, cacheWrite: hit.cacheWrite }
        : null;
    });
  }
  // A model behind an Anthropic-compatible gateway (`gateway:<model>`): a Claude model is priced from the Claude table; anything
  // else has no price we can vouch for.
  if (model.startsWith('gateway:')) {
    const lower = model.toLowerCase();
    return table.some((x) => x.match !== '' && lower.includes(x.match)) ? undefined : null;
  }
  const d = splitDirectModel(model);
  if (!d) return undefined;
  return directPrice(d.provider, d.model, (m) => {
    const lower = m.toLowerCase();
    const hit = table.find((x) => x.match !== '' && lower.includes(x.match));
    return hit
      ? { input: hit.input, output: hit.output, cacheRead: hit.cacheRead, cacheWrite: hit.cacheWrite }
      : null;
  });
}

/**
 * A model of the direct-model runtime with no price in the tables: its cost shows as 0 and must be flagged "cost unknown"
 * wherever it is shown. Every other model is priced (an unknown one like Sonnet).
 */
export function isCostUnknown(
  model: string,
  table: readonly ModelPrice[] = DEFAULT_MODEL_PRICES,
  owner?: readonly OwnerModelPrice[],
): boolean {
  return directPriceOf(model, table, owner) === null;
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
  owner?: readonly OwnerModelPrice[],
): number {
  const direct = directPriceOf(model, table, owner);
  if (direct !== undefined) {
    if (direct === null) return 0; // unknown price: zero here, flagged by `isCostUnknown` (never silently priced as Sonnet)
    // Thousandths of a micro-USD: cache prices like $0.025 per million stay exact.
    const c = (price: number) => Math.round(price * 1000);
    const total =
      usage.inputTokens * c(direct.input) +
      usage.outputTokens * c(direct.output) +
      (usage.cacheReadTokens ?? 0) * c(direct.cacheRead ?? direct.input) +
      (usage.cacheWriteTokens ?? 0) * c(direct.cacheWrite ?? direct.input);
    return Math.floor((total + 500) / 1000);
  }
  const p = priceFor(model, table);
  // Integer arithmetic in hundredths of a micro-USD so the result is exact (and equals the SQL backfill's numeric math).
  const c = (price: number) => Math.round(price * 100);
  const writes = usage.cacheWriteTokens ?? 0;
  const writes1h = Math.min(writes, Math.max(0, usage.cacheWrite1hTokens ?? 0));
  const total =
    usage.inputTokens * c(p.input) +
    usage.outputTokens * c(p.output) +
    (usage.cacheReadTokens ?? 0) * c(p.cacheRead) +
    (writes - writes1h) * c(p.cacheWrite) +
    writes1h * c(p.cacheWrite1h);
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
