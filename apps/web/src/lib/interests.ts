import {
  ALL_INTEREST_KINDS,
  type CreateInterestRequest,
  type DeliverySpec,
  defaultWindowHours,
  type InterestDto,
  type InterestKind,
  type InterestRunStatus,
  type InterestStats,
  type PatchInterestRequest,
  SCHEDULE_PRESETS,
  type ScanSpec,
} from '@aom/shared';
import { describeCron, parseSites } from './feeds.ts';

/** The run schedule line of an interest: "Daily at 07:00 (Africa/Johannesburg) · 24 h window · up to 10 items", or "Manual only". */
export function describeScan(scan: ScanSpec): string {
  const when = scan.manual ? 'Manual only' : `${describeCron(scan.cron)} (${scan.timezone})`;
  return `${when} · up to ${scan.maxItems} items`;
}

/** The delivery line: "As soon as a run finishes", or "Weekdays at 07:00 (Africa/Johannesburg)". */
export function describeDelivery(d: DeliverySpec): string {
  return d.mode === 'immediate' ? 'As soon as a run finishes' : `${describeCron(d.cron)} (${d.timezone})`;
}

/** "U12 I3 B5 ?2": the compact ratings line for narrow screens. */
export function compactRatings(r: InterestStats['ratings']): string {
  return `U${r.useful} I${r.irrelevant} B${r.boring} ?${r.unrated}`;
}

export function describeRatings(r: InterestStats['ratings']): string {
  return `useful ${r.useful} · irrelevant ${r.irrelevant} · boring ${r.boring} · unrated ${r.unrated}`;
}

/** Preset id of a cron expression, or `custom`. */
export function presetFor(cron: string): string {
  const c = cron.trim().replace(/\s+/g, ' ');
  return SCHEDULE_PRESETS.find((p) => p.cron === c)?.id ?? 'custom';
}

/** The window the form shows as a placeholder: derived from the cadence. */
export const derivedWindow = (cron: string): number => defaultWindowHours(cron);

export const RUN_STATUS_LABEL: Record<InterestRunStatus, string> = {
  queued: 'Queued',
  scanning: 'Scanning',
  curating: 'Curating',
  researching: 'Researching',
  checking: 'Fact checking',
  published: 'Published',
  nothing: 'Nothing qualified',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const runStatusTone = (s: InterestRunStatus): 'green' | 'amber' | 'red' | 'neutral' | 'blue' =>
  s === 'published'
    ? 'green'
    : s === 'failed'
      ? 'red'
      : s === 'cancelled' || s === 'nothing'
        ? 'neutral'
        : s === 'queued'
          ? 'amber'
          : 'blue';

export interface InterestFormValues {
  name: string;
  description: string;
  domain: 'personal' | 'work';
  subCategory: string;
  sites: string;
  kinds: Record<InterestKind, boolean>;
  preset: string;
  cron: string;
  timezone: string;
  windowHours: string;
  maxItems: string;
  manual: boolean;
  deliveryMode: 'immediate' | 'scheduled';
  deliveryPreset: string;
  deliveryCron: string;
  deliveryTimezone: string;
  status: 'active' | 'paused';
}

const allKinds = (): Record<InterestKind, boolean> => ({ article: true, video: true, podcast: true });

export function valuesFromInterest(i: InterestDto): InterestFormValues {
  const kinds = allKinds();
  for (const k of ALL_INTEREST_KINDS) kinds[k] = i.kinds.includes(k);
  return {
    name: i.name,
    description: i.description,
    domain: i.domain,
    subCategory: i.subCategory ?? '',
    sites: i.preferredSites.join('\n'),
    kinds,
    preset: presetFor(i.scan.cron),
    cron: i.scan.cron,
    timezone: i.scan.timezone,
    // Empty while it is the cadence's default, so a new cadence brings its own default window.
    windowHours: i.scan.windowHours !== defaultWindowHours(i.scan.cron) ? String(i.scan.windowHours) : '',
    maxItems: String(i.scan.maxItems),
    manual: i.scan.manual,
    deliveryMode: i.delivery.mode,
    deliveryPreset: presetFor(i.delivery.cron),
    deliveryCron: i.delivery.cron,
    deliveryTimezone: i.delivery.timezone,
    status: i.status,
  };
}

export function emptyValues(zone: string): InterestFormValues {
  const daily = SCHEDULE_PRESETS[0];
  const weekdays = SCHEDULE_PRESETS[2];
  return {
    name: '',
    description: '',
    domain: 'personal',
    subCategory: '',
    sites: '',
    kinds: allKinds(),
    preset: daily.id,
    cron: daily.cron,
    timezone: zone,
    windowHours: '',
    maxItems: '10',
    manual: false,
    deliveryMode: 'scheduled',
    deliveryPreset: weekdays.id,
    deliveryCron: weekdays.cron,
    deliveryTimezone: zone,
    status: 'active',
  };
}

const cronFrom = (preset: string, custom: string): string =>
  preset === 'custom'
    ? custom.trim()
    : (SCHEDULE_PRESETS.find((p) => p.id === preset)?.cron ?? custom.trim());

/** The cron of the run schedule: the preset's, or the typed custom one. */
export const cronOf = (v: Pick<InterestFormValues, 'preset' | 'cron'>): string => cronFrom(v.preset, v.cron);
export const deliveryCronOf = (v: Pick<InterestFormValues, 'deliveryPreset' | 'deliveryCron'>): string =>
  cronFrom(v.deliveryPreset, v.deliveryCron);

export type FormErrors = Partial<
  Record<'name' | 'cron' | 'deliveryCron' | 'maxItems' | 'windowHours' | 'kinds', string>
>;

/** Client-side checks before the request (the server checks everything again). */
export function validateInterest(v: InterestFormValues): FormErrors {
  const errors: FormErrors = {};
  if (!v.name.trim()) errors.name = 'A name is required';
  if (!v.manual && v.preset === 'custom' && v.cron.trim().split(/\s+/).length !== 5)
    errors.cron = 'The cron expression needs 5 fields: minute hour day month weekday';
  if (
    v.deliveryMode === 'scheduled' &&
    v.deliveryPreset === 'custom' &&
    v.deliveryCron.trim().split(/\s+/).length !== 5
  )
    errors.deliveryCron = 'The cron expression needs 5 fields: minute hour day month weekday';
  const max = Number.parseInt(v.maxItems, 10);
  if (!Number.isFinite(max) || max < 1 || max > 100) errors.maxItems = 'Max items is 1 to 100';
  if (v.windowHours.trim()) {
    const w = Number.parseInt(v.windowHours, 10);
    if (!Number.isFinite(w) || w < 1 || w > 720) errors.windowHours = 'Window is 1 to 720 hours';
  }
  if (!ALL_INTEREST_KINDS.some((k) => v.kinds[k])) errors.kinds = 'Choose at least one kind of item';
  return errors;
}

const scanBody = (v: InterestFormValues) => ({
  cron: cronOf(v),
  timezone: v.timezone.trim() || 'UTC',
  ...(v.windowHours.trim() ? { windowHours: Number.parseInt(v.windowHours, 10) } : {}),
  maxItems: Number.parseInt(v.maxItems, 10) || 10,
  manual: v.manual,
});

const deliveryBody = (v: InterestFormValues) => ({
  mode: v.deliveryMode,
  cron: deliveryCronOf(v) || '0 7 * * 1-5',
  timezone: v.deliveryTimezone.trim() || 'UTC',
});

const kindsOf = (v: InterestFormValues): InterestKind[] => ALL_INTEREST_KINDS.filter((k) => v.kinds[k]);

export function toCreateRequest(v: InterestFormValues, tasteRules: string[] = []): CreateInterestRequest {
  return {
    name: v.name.trim(),
    description: v.description,
    domain: v.domain,
    preferredSites: parseSites(v.sites),
    kinds: kindsOf(v),
    scan: scanBody(v),
    delivery: deliveryBody(v),
    tasteRules,
    status: v.status,
    ...(v.subCategory.trim() ? { subCategory: v.subCategory.trim() } : {}),
  };
}

export function toPatchRequest(v: InterestFormValues, domainLocked: boolean): PatchInterestRequest {
  return {
    name: v.name.trim(),
    description: v.description,
    ...(domainLocked ? {} : { domain: v.domain }),
    subCategory: v.subCategory.trim() || null,
    preferredSites: parseSites(v.sites),
    kinds: kindsOf(v),
    scan: scanBody(v),
    delivery: deliveryBody(v),
    status: v.status,
  };
}
