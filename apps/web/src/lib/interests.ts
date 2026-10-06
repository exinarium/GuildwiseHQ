import {
  defaultWindowHours,
  type InterestDto,
  type InterestStats,
  SCHEDULE_PRESETS,
  type ScanSpec,
} from '@aom/shared';
import { describeCron } from './feeds.ts';

/** The cadence line of an interest: "Daily at 07:00 (Africa/Johannesburg) · 24 h · 10 items", or "Manual only". */
export function describeScan(scan: ScanSpec | null): string {
  if (!scan) return 'No feed';
  const when = scan.manual ? 'Manual only' : `${describeCron(scan.cron)} (${scan.timezone})`;
  return `${when} · ${scan.windowHours} h · ${scan.maxItems} items`;
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

export interface InterestFormValues {
  name: string;
  description: string;
  feedProjectId: string;
  researchProjectId: string;
  newFeed: boolean;
  newFeedKey: string;
  newFeedName: string;
  newFeedDomain: 'personal' | 'work';
  subCategory: string;
  sites: string;
  preset: string;
  cron: string;
  timezone: string;
  windowHours: string;
  maxItems: string;
  manual: boolean;
  status: 'active' | 'paused';
}

export function valuesFromInterest(i: InterestDto, fallbackZone: string): InterestFormValues {
  const scan = i.scan;
  return {
    name: i.name,
    description: i.description,
    feedProjectId: i.feedProject?.id ?? '',
    researchProjectId: i.researchProject?.id ?? '',
    newFeed: false,
    newFeedKey: '',
    newFeedName: '',
    newFeedDomain: 'personal',
    subCategory: i.subCategory ?? '',
    sites: i.preferredSites.join('\n'),
    preset: scan ? presetFor(scan.cron) : SCHEDULE_PRESETS[0].id,
    cron: scan?.cron ?? SCHEDULE_PRESETS[0].cron,
    timezone: scan?.timezone ?? fallbackZone,
    // Empty while it is the cadence's default, so a new cadence brings its own default window.
    windowHours: scan && scan.windowHours !== defaultWindowHours(scan.cron) ? String(scan.windowHours) : '',
    maxItems: String(scan?.maxItems ?? 10),
    manual: scan?.manual ?? false,
    status: i.status,
  };
}

export function emptyValues(zone: string): InterestFormValues {
  return {
    name: '',
    description: '',
    feedProjectId: '',
    researchProjectId: '',
    newFeed: false,
    newFeedKey: '',
    newFeedName: '',
    newFeedDomain: 'personal',
    subCategory: '',
    sites: '',
    preset: SCHEDULE_PRESETS[0].id,
    cron: SCHEDULE_PRESETS[0].cron,
    timezone: zone,
    windowHours: '',
    maxItems: '10',
    manual: false,
    status: 'active',
  };
}

/** The cron of the form: the preset's, or the typed custom one. */
export const cronOf = (v: Pick<InterestFormValues, 'preset' | 'cron'>): string =>
  v.preset === 'custom'
    ? v.cron.trim()
    : (SCHEDULE_PRESETS.find((p) => p.id === v.preset)?.cron ?? v.cron.trim());

export type FormErrors = Partial<
  Record<'name' | 'project' | 'cron' | 'maxItems' | 'windowHours' | 'newFeed', string>
>;

/** Client-side checks before the request (the server checks everything again). */
export function validateInterest(v: InterestFormValues): FormErrors {
  const errors: FormErrors = {};
  if (!v.name.trim()) errors.name = 'A name is required';
  const hasFeed = v.newFeed || !!v.feedProjectId;
  if (!hasFeed && !v.researchProjectId) errors.project = 'Choose a feed project, a research project or both';
  if (hasFeed) {
    if (v.preset === 'custom' && v.cron.trim().split(/\s+/).length !== 5)
      errors.cron = 'The cron expression needs 5 fields: minute hour day month weekday';
    const max = Number.parseInt(v.maxItems, 10);
    if (!Number.isFinite(max) || max < 1 || max > 100) errors.maxItems = 'Max items is 1 to 100';
    if (v.windowHours.trim()) {
      const w = Number.parseInt(v.windowHours, 10);
      if (!Number.isFinite(w) || w < 1 || w > 720) errors.windowHours = 'Window is 1 to 720 hours';
    }
  }
  if (v.newFeed) {
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(v.newFeedKey) || !v.newFeedName.trim())
      errors.newFeed =
        'A new feed project needs a key (2-10 letters or digits, starting with a letter) and a name';
  }
  return errors;
}
