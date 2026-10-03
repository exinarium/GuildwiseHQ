import type { StatValue } from '@aom/shared';

/** `0.3333` -> `33%`; null (not enough data) -> an en dash. */
export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '–';
  const p = v * 100;
  return `${p > 0 && p < 1 ? '<1' : Math.round(p)}%`;
}

export function num(v: number | null | undefined): string {
  if (v === null || v === undefined) return '–';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function tokens(v: number | null | undefined): string {
  if (v === null || v === undefined) return '–';
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : String(v);
}

/** `7_200_000` -> `2h`, `90_000` -> `1.5m`, `4_000` -> `4s`. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
  const h = m / 60;
  if (h < 48) return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
  return `${Math.round(h / 24)}d`;
}

export type Direction = 'better' | 'worse' | 'same' | 'unknown';

/** Whether a value beats the team average. `lowerIsBetter`: blocked and rework rates, bugs, tokens. */
export function versusTeam(s: StatValue, lowerIsBetter: boolean): Direction {
  if (s.value === null || s.team === null) return 'unknown';
  const diff = s.value - s.team;
  if (Math.abs(diff) < 1e-9) return 'same';
  return diff < 0 === lowerIsBetter ? 'better' : 'worse';
}

/** A short accessible sentence for a stat: `12% (team 8%)`. */
export function describeStat(s: StatValue, fmt: (n: number | null) => string): string {
  return s.team === null ? fmt(s.value) : `${fmt(s.value)} (team ${fmt(s.team)})`;
}
