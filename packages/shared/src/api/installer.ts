import { z } from 'zod';
import { IsoTime } from './common.ts';

/**
 * The "Add a workstation" wizard.
 * `POST /api/workstations/installers` makes a wizard session: a fresh one-time pairing code and short-lived script links.
 */
export const InstallerOsSchema = z.enum(['linux', 'macos', 'windows']);
export type InstallerOs = z.infer<typeof InstallerOsSchema>;

export const CreateInstallerRequestSchema = z.object({
  os: InstallerOsSchema,
  /** Suggested workstation name; empty: the machine's host name. */
  name: z.string().trim().max(80).optional(),
});
export type CreateInstallerRequest = z.infer<typeof CreateInstallerRequestSchema>;

export const InstallerReleaseSchema = z.object({
  version: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
});
export type InstallerRelease = z.infer<typeof InstallerReleaseSchema>;

export const InstallerSessionSchema = z.object({
  id: z.uuid(),
  os: InstallerOsSchema,
  expiresAt: IsoTime,
  /** The command to paste: `curl ... | bash` or `irm ... | iex`. The URL in it works for 30 minutes. */
  oneLiner: z.string(),
  /** The script as a download (same short-lived link, with `?download=1`). */
  downloadUrl: z.string(),
  fileName: z.string(),
  release: InstallerReleaseSchema.nullable(),
});
export type InstallerSession = z.infer<typeof InstallerSessionSchema>;

export const InstallerStepStatusSchema = z.enum(['start', 'ok', 'warn', 'fail', 'info', 'done']);
export type InstallerStepStatus = z.infer<typeof InstallerStepStatusSchema>;

/** `POST /install/:token/progress` (unauthenticated; the token is the credential). Sent by the install scripts. */
export const InstallerProgressRequestSchema = z.object({
  step: z.string().trim().min(1).max(80),
  status: InstallerStepStatusSchema,
  detail: z.string().max(400).optional(),
});
export type InstallerProgressRequest = z.infer<typeof InstallerProgressRequestSchema>;

export const InstallerStepSchema = z.object({
  step: z.string(),
  status: InstallerStepStatusSchema,
  detail: z.string(),
  at: IsoTime,
});
export type InstallerStep = z.infer<typeof InstallerStepSchema>;

/**
 * waiting: nothing yet; running: the script started; paired: the runner paired; checking: doctor results are coming in;
 * done: the script finished (`result`); expired: the links ran out before the install started.
 */
export const InstallerStateSchema = z.enum(['waiting', 'running', 'paired', 'checking', 'done', 'expired']);
export type InstallerState = z.infer<typeof InstallerStateSchema>;

export const InstallerStatusSchema = z.object({
  id: z.uuid(),
  os: InstallerOsSchema,
  state: InstallerStateSchema,
  /** `success` or `failed` once the script finished. */
  result: z.enum(['success', 'failed']).nullable(),
  expiresAt: IsoTime,
  workstationId: z.uuid().nullable(),
  workstationName: z.string().nullable(),
  /** What the script reported, in order (not the doctor lines). */
  steps: z.array(InstallerStepSchema),
  /** `aom-runner doctor` lines, as they came in. */
  doctor: z.array(InstallerStepSchema),
});
export type InstallerStatus = z.infer<typeof InstallerStatusSchema>;

/** `GET /api/runner/release` (public): the runner download the server offers. */
export const RunnerReleaseResponseSchema = InstallerReleaseSchema.extend({
  url: z.string(),
  /** A super admin paused runner auto-updates: runners that see `true` keep the version they have. */
  autoUpdatePaused: z.boolean().default(false),
});
export type RunnerReleaseResponse = z.infer<typeof RunnerReleaseResponseSchema>;

/** `GET/PUT /api/platform/runner-updates` (super admin): the kill switch for runner auto-updates. */
export const RunnerUpdateSettingsSchema = z.object({
  paused: z.boolean(),
  updatedAt: z.iso.datetime().nullable(),
  /** The runner version this server offers (null: none published). */
  latestVersion: z.string().nullable(),
});
export type RunnerUpdateSettings = z.infer<typeof RunnerUpdateSettingsSchema>;
export const SetRunnerUpdateSettingsRequestSchema = z.object({ paused: z.boolean() });
