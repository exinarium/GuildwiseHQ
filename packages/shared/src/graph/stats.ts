/**
 * The statistics behind the token-saving claim (docs/design/project-graphs.md section 11): medians and quartiles of the
 * billed input tokens per accepted card for each arm, and the ratio of the arms with a bootstrap interval that resamples
 * inside strata (card type and size), so a mix of big features in one arm cannot fake a saving. Pure and deterministic
 * (a seeded generator), so the same data always gives the same interval.
 */

export interface Sample {
  /** Billed input tokens of one accepted card (all its measured shifts). */
  value: number;
  /** The stratum the card belongs to, for example `feature/large`. */
  stratum: string;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

export const median = (xs: number[]): number =>
  quantile(
    [...xs].sort((a, b) => a - b),
    0.5,
  );

export interface ArmSummary {
  cards: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
}

export function summarize(samples: Sample[]): ArmSummary {
  const v = samples.map((s) => s.value).sort((a, b) => a - b);
  if (v.length === 0) return { cards: 0, median: null, p25: null, p75: null };
  return { cards: v.length, median: quantile(v, 0.5), p25: quantile(v, 0.25), p75: quantile(v, 0.75) };
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byStratum = (xs: Sample[]): Map<string, number[]> => {
  const m = new Map<string, number[]>();
  for (const s of xs) (m.get(s.stratum) ?? m.set(s.stratum, []).get(s.stratum))?.push(s.value);
  return m;
};

function resample(groups: Map<string, number[]>, rand: () => number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const g of [...groups.keys()].sort()) {
    const v = groups.get(g) as number[];
    out.set(
      g,
      v.map(() => v[Math.floor(rand() * v.length)] as number),
    );
  }
  return out;
}

/**
 * The stratified ratio: for every stratum that has cards in both arms the ratio of the arms' medians, combined as a
 * weighted geometric mean (weight: the cards of the stratum in both arms). A graph arm that happens to hold more cheap
 * cards does not look like a saving: each kind of card is compared with its own kind. With no stratum in common it falls
 * back to the ratio of the pooled medians. Null when the holdout side has no positive median.
 */
function stratifiedRatio(on: Map<string, number[]>, off: Map<string, number[]>): number | null {
  let wSum = 0;
  let logSum = 0;
  for (const [stratum, a] of on) {
    const b = off.get(stratum);
    if (!b || a.length === 0 || b.length === 0) continue;
    const mOff = median(b);
    const mOn = median(a);
    if (!(mOff > 0) || !(mOn > 0)) continue;
    const w = a.length + b.length;
    wSum += w;
    logSum += w * Math.log(mOn / mOff);
  }
  if (wSum > 0) return Math.exp(logSum / wSum);
  const pooledOff = median([...off.values()].flat());
  const pooledOn = median([...on.values()].flat());
  return pooledOff > 0 ? pooledOn / pooledOff : null;
}

export interface RatioInterval {
  /** Billed tokens of the graph arm over the holdout arm (stratified): below 1 is a saving. */
  ratio: number;
  lo: number;
  hi: number;
}

/**
 * The stratified ratio of the arms (`on` over `off`) with a 95% bootstrap interval, resampling within each stratum and arm.
 * Null when an arm has no cards or no ratio can be formed.
 */
export function bootstrapRatio(
  on: Sample[],
  off: Sample[],
  iterations = 2000,
  seed = 1,
): RatioInterval | null {
  if (on.length === 0 || off.length === 0) return null;
  const gOn = byStratum(on);
  const gOff = byStratum(off);
  const point = stratifiedRatio(gOn, gOff);
  if (point === null) return null;
  const rand = rng(seed);
  const ratios: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const r = stratifiedRatio(resample(gOn, rand), resample(gOff, rand));
    if (r !== null) ratios.push(r);
  }
  if (ratios.length < iterations / 2) return null;
  ratios.sort((x, y) => x - y);
  return { ratio: point, lo: quantile(ratios, 0.025), hi: quantile(ratios, 0.975) };
}

/** The quality measures of one arm, per accepted card. A saving that costs quality is not a saving. */
export interface Guards {
  /** Average rework rounds per accepted card. */
  reworkRounds: number;
  /** Reviewer "changes requested" outcomes per accepted card. */
  changesRequested: number;
  /** Tester failures per accepted card. */
  testerFailures: number;
  /** Average days from creation to done. */
  daysToDone: number;
  /** Average cost of an accepted card in USD (the unit the owner pays for). */
  costPerCardUsd: number;
}

export const MIN_CARDS_PER_ARM = 10;

export interface Claim {
  allowed: boolean;
  /** Why not (a fixed code), or `ok`. */
  reason: 'ok' | 'not_enough_cards' | 'interval_includes_one' | 'no_saving' | 'guard_worse';
  /** The saving as a percentage, only when the claim is allowed (`1 - ratio`, rounded down to a whole percent). */
  savingPercent: number | null;
  /** Which guards are worse in the graph arm. */
  worseGuards: Array<keyof Guards>;
}

/**
 * The public claim ("X% fewer tokens") is allowed only when both arms have enough accepted cards, the whole interval of the
 * ratio is below 1, and no quality guard is worse in the graph arm (section 11).
 */
export function graphClaim(
  on: ArmSummary,
  off: ArmSummary,
  interval: RatioInterval | null,
  guardsOn: Guards | null,
  guardsOff: Guards | null,
): Claim {
  const none = { savingPercent: null, worseGuards: [] as Array<keyof Guards> };
  if (on.cards < MIN_CARDS_PER_ARM || off.cards < MIN_CARDS_PER_ARM || !interval)
    return { allowed: false, reason: 'not_enough_cards', ...none };
  if (interval.ratio >= 1) return { allowed: false, reason: 'no_saving', ...none };
  if (interval.hi >= 1) return { allowed: false, reason: 'interval_includes_one', ...none };
  const worse: Array<keyof Guards> = [];
  if (guardsOn && guardsOff)
    for (const k of Object.keys(guardsOn) as Array<keyof Guards>)
      if (guardsOn[k] > guardsOff[k] * 1.0001 + 1e-9) worse.push(k);
  if (worse.length) return { allowed: false, reason: 'guard_worse', savingPercent: null, worseGuards: worse };
  return {
    allowed: true,
    reason: 'ok',
    savingPercent: Math.floor((1 - interval.ratio) * 100),
    worseGuards: [],
  };
}
