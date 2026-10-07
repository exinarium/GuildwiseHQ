import { formatMoney } from '@aom/shared';

/** `$12.34` in the organization's currency; micro-units in, text out. */
export const money = (micros: number | null | undefined, currency = 'USD'): string =>
  micros === null || micros === undefined ? '–' : formatMoney(micros, currency);

/** `82%` (whole percent) or an en dash. */
export const percentText = (p: number | null | undefined): string =>
  p === null || p === undefined ? '–' : `${Math.floor(p)}%`;

/** The first of next month as a short date: "1 Nov". */
export const resetDay = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
