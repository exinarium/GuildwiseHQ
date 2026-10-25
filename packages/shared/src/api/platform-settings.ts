import { z } from 'zod';
import { IsoTime } from './common.ts';

/** What the app attaches to a request for help, and the platform administrator's notification settings. */
/** One recent error from the browser's small ring buffer. */
export const ClientErrorSchema = z.object({
  at: IsoTime,
  message: z.string().max(300),
  source: z.string().max(200).optional(),
});
export type ClientError = z.infer<typeof ClientErrorSchema>;

/** What the app attaches to a request: where the person was and what they were running. */
export const SupportContextSchema = z.object({
  page: z.string().max(300).optional(),
  appVersion: z.string().max(60).optional(),
  browser: z.string().max(300).optional(),
  language: z.string().max(40).optional(),
  viewport: z.string().max(40).optional(),
  timeZone: z.string().max(80).optional(),
  errors: z.array(ClientErrorSchema).max(10).optional(),
});
export type SupportContext = z.infer<typeof SupportContextSchema>;

/** The addresses of an email-list setting (one, or several separated by commas), as an array. */
export const splitEmails = (v: string | null | undefined): string[] =>
  (v ?? '').split(/[,;\s]+/).filter(Boolean);

/** One address, or several separated by commas. */
export const EmailListSchema = z
  .string()
  .max(400)
  .refine((v) => {
    const list = splitEmails(v);
    return list.length > 0 && list.every((a) => z.email().safeParse(a).success);
  }, 'enter one or more valid email addresses, separated by commas');

export const PlatformSettingsSchema = z.object({
  /** New requests from signed-in users (and their follow-ups) are emailed here. Unset: the server's `AOM_SUPPORT_EMAIL`. */
  supportEmail: EmailListSchema.nullable(),
  /** New Contact us messages from visitors are emailed here. Unset: the support address. */
  contactEmail: EmailListSchema.nullable(),
  /** Also email the support address(es) when an organization is created or an invitation is accepted. Off by default. */
  notifyNewOrgs: z.boolean(),
  /** Also email the support address(es) about every platform audit event. Off by default. */
  notifyAuditEvents: z.boolean(),
});
export type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;
/** An empty string clears the setting. */
export const PatchPlatformSettingsRequestSchema = z.object({
  supportEmail: z.union([EmailListSchema, z.literal('')]).optional(),
  contactEmail: z.union([EmailListSchema, z.literal('')]).optional(),
  notifyNewOrgs: z.boolean().optional(),
  notifyAuditEvents: z.boolean().optional(),
});
