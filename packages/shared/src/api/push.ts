import { z } from 'zod';

/**
 * Web Push (mobile PWA): what a person can be notified about, per device subscription and per preference.
 * `GET /api/push/config`, `GET/POST /api/push/subscriptions`, `DELETE /api/push/subscriptions/:id`,
 * `GET/PUT /api/push/preferences`, `POST /api/push/test`.
 */
export const PUSH_CATEGORIES = [
  'desk_blocking',
  'owner_approvals',
  'platform_deploys',
  'budget_paused',
  'runner_alerts',
  'platform_bugs',
  'project_pause',
  'chat_replies',
  'session_time',
] as const;
export const PushCategorySchema = z.enum(PUSH_CATEGORIES);
export type PushCategory = z.infer<typeof PushCategorySchema>;

export const PUSH_CATEGORY_INFO: Record<
  PushCategory,
  { label: string; description: string; defaultOn: boolean }
> = {
  desk_blocking: {
    label: 'Questions and decisions for me',
    description: 'A blocking question or a decision on your Desk that only you can answer.',
    defaultOn: true,
  },
  owner_approvals: {
    label: 'Owner approvals',
    description:
      'A card waits for your approval of its code (the diff you approve is the one you are shown).',
    defaultOn: true,
  },
  platform_deploys: {
    label: 'Platform deploy approvals',
    description: 'A Guildwise deploy waits for the platform team to approve it.',
    defaultOn: true,
  },
  budget_paused: {
    label: 'Budget used up',
    description: 'A project reached its monthly budget and stopped picking up work.',
    defaultOn: true,
  },
  runner_alerts: {
    label: 'Runner offline, login expired, usage limit',
    description: 'A workstation went offline, its Claude login expired or the usage limit was hit.',
    defaultOn: true,
  },
  platform_bugs: {
    label: 'Platform bugs',
    description: 'A new bug was filed for the platform team (platform organization only).',
    defaultOn: true,
  },
  project_pause: {
    label: 'Project paused or resumed',
    description: 'An Owner or Admin paused or resumed a project.',
    defaultOn: true,
  },
  chat_replies: {
    label: 'Chat replies',
    description: 'An agent answered you in a chat.',
    defaultOn: false,
  },
  session_time: {
    label: 'Session time limit',
    description:
      'Your Discovery or Boardroom session is about to reach its time limit, or the time is up and it waits for you to extend or wrap up.',
    defaultOn: true,
  },
};

export const PushConfigSchema = z.object({
  enabled: z.boolean(),
  /** The VAPID public key (base64url) the browser subscribes with; absent when push is disabled. */
  publicKey: z.string().optional(),
});
export type PushConfig = z.infer<typeof PushConfigSchema>;

export const PushSubscribeRequestSchema = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  /** A label for the device list ("iPhone Safari"); the server derives one from the user agent when absent. */
  label: z.string().trim().min(1).max(80).optional(),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequestSchema>;

export const PushDeviceSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  endpoint: z.string(),
  createdAt: z.iso.datetime(),
  lastSuccessAt: z.iso.datetime().nullable(),
  lastFailureAt: z.iso.datetime().nullable(),
  failureCount: z.number().int(),
});
export type PushDevice = z.infer<typeof PushDeviceSchema>;
export const PushDevicesSchema = z.object({ devices: z.array(PushDeviceSchema) });
export type PushDevices = z.infer<typeof PushDevicesSchema>;

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const QuietHoursSchema = z.object({ enabled: z.boolean(), start: Hhmm, end: Hhmm });
export const PushPreferencesSchema = z.object({
  categories: z.record(PushCategorySchema, z.boolean()),
  /** In the person's own time zone; while it applies only blocking items go through. */
  quietHours: QuietHoursSchema,
});
export type PushPreferences = z.infer<typeof PushPreferencesSchema>;

export const PushPreferencesUpdateSchema = z.object({
  categories: z.partialRecord(PushCategorySchema, z.boolean()).optional(),
  quietHours: QuietHoursSchema.optional(),
  /** Save as the default for every organization of the person (their per-organization overrides are dropped). */
  allOrgs: z.boolean().optional(),
});
export type PushPreferencesUpdate = z.infer<typeof PushPreferencesUpdateSchema>;

export const defaultPushPreferences = (): PushPreferences => ({
  categories: Object.fromEntries(PUSH_CATEGORIES.map((c) => [c, PUSH_CATEGORY_INFO[c].defaultOn])) as Record<
    PushCategory,
    boolean
  >,
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
});

export const PushTestResultSchema = z.object({ sent: z.number().int(), failed: z.number().int() });
export type PushTestResult = z.infer<typeof PushTestResultSchema>;

/** What the service worker receives (JSON in the push payload). */
export const PushPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  url: z.string(),
  tag: z.string(),
  badge: z.number().int().nonnegative(),
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;
