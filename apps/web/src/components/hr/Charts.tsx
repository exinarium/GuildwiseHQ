import type { ReactNode } from 'react';

/**
 * Small, dependency-free SVG charts. Colour is never the only carrier of meaning: every chart has a text label and the
 * numbers next to it. They follow the page's light and dark theme through `currentColor` and Tailwind classes.
 */

/** Tiny bars, one per value (for example cards done per day). */
export function Sparkline({
  values,
  label,
  width = 84,
  height = 22,
}: {
  values: number[];
  label: string;
  width?: number;
  height?: number;
}) {
  const max = Math.max(1, ...values);
  const gap = 1;
  const bw = Math.max(1, (width - gap * (values.length - 1)) / Math.max(1, values.length));
  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="text-indigo-600 dark:text-indigo-400"
    >
      <title>{label}</title>
      {values.map((v, i) => {
        const h = v === 0 ? 1 : Math.max(2, (v / max) * (height - 2));
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
            key={i}
            x={i * (bw + gap)}
            y={height - h}
            width={bw}
            height={h}
            rx={0.5}
            fill="currentColor"
            opacity={v === 0 ? 0.25 : 1}
          />
        );
      })}
    </svg>
  );
}

/** A value on a 0..max track with a tick for the team average. */
export function CompareBar({
  value,
  team,
  max = 1,
  label,
}: {
  value: number | null;
  team: number | null;
  max?: number;
  label: string;
}) {
  const w = (n: number) => `${Math.max(0, Math.min(100, (n / max) * 100))}%`;
  return (
    <div
      role="img"
      aria-label={label}
      title={label}
      className="relative h-1.5 w-full rounded-full bg-zinc-200 dark:bg-zinc-700"
    >
      {value !== null && (
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-indigo-600 dark:bg-indigo-400"
          style={{ width: w(value) }}
        />
      )}
      {team !== null && (
        <div
          className="absolute -top-0.5 h-2.5 w-0.5 bg-zinc-800 dark:bg-zinc-100"
          style={{ left: w(team) }}
          data-testid="team-tick"
        />
      )}
    </div>
  );
}

export interface BarDatum {
  label: string;
  value: number;
}

/** Vertical bars with the value above each bar and the label below; `caption` is the accessible name. */
export function BarChart({
  data,
  caption,
  height = 96,
  format,
}: {
  data: BarDatum[];
  caption: string;
  height?: number;
  format?: (n: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const bw = 100 / Math.max(1, data.length);
  return (
    <figure className="m-0">
      <svg
        role="img"
        aria-label={`${caption}: ${data.map((d) => `${d.label} ${format ? format(d.value) : d.value}`).join(', ')}`}
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="w-full text-indigo-600 dark:text-indigo-400"
        style={{ height }}
      >
        <title>{caption}</title>
        <line
          x1="0"
          x2="100"
          y1={height - 0.5}
          y2={height - 0.5}
          stroke="currentColor"
          opacity="0.3"
          strokeWidth="0.5"
        />
        {data.map((d, i) => {
          const h = d.value === 0 ? 0 : Math.max(1.5, (d.value / max) * (height - 4));
          return (
            <rect
              key={d.label}
              x={i * bw + bw * 0.15}
              y={height - 0.5 - h}
              width={bw * 0.7}
              height={h}
              fill="currentColor"
            />
          );
        })}
      </svg>
      <figcaption className="sr-only">{caption}</figcaption>
    </figure>
  );
}

/** Horizontal labelled bars with the numbers shown: for queue depth and per-agent durations. */
export function HBars({
  data,
  caption,
  format,
}: {
  data: BarDatum[];
  caption: string;
  format?: (n: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul aria-label={caption} className="flex flex-col gap-1.5">
      {data.map((d) => (
        <li key={d.label} className="grid grid-cols-[7rem_1fr_3.5rem] items-center gap-2 text-sm">
          <span className="truncate text-zinc-600 dark:text-zinc-400">{d.label}</span>
          <span className="h-2 rounded-full bg-zinc-200 dark:bg-zinc-700" aria-hidden="true">
            <span
              className="block h-2 rounded-full bg-indigo-600 dark:bg-indigo-400"
              style={{ width: `${(d.value / max) * 100}%` }}
            />
          </span>
          <span className="text-right tabular-nums">{format ? format(d.value) : d.value}</span>
        </li>
      ))}
    </ul>
  );
}

export function Stat({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}
