import { z } from 'zod';
import { RightsReportSchema } from '../devops/environment.ts';
import { DevOpsAccessSchema } from '../events/devops.ts';
import { RuntimeInfoSchema } from '../protocol/runner.ts';
import { IsoTime } from './common.ts';

/** Repository hygiene of a workstation: its cadence and the last run (docs/design/phases.md addendum). */
export const WorkstationHygieneSchema = z.object({
  intervalHours: z.number().int().nonnegative(),
  lastRunAt: IsoTime.nullable(),
  nextRunAt: IsoTime.nullable(),
  lastRequestId: z.uuid().nullable(),
  lastStatus: z.string().nullable(),
  openFindings: z.number().int().nonnegative(),
});
export type WorkstationHygiene = z.infer<typeof WorkstationHygieneSchema>;

export const WorkstationDtoSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string(),
  platform: z.string().nullable(),
  hostname: z.string().nullable(),
  runnerVersion: z.string().nullable(),
  status: z.enum(['active', 'unlinked']),
  connected: z.boolean(),
  lastSeenAt: IsoTime.nullable(),
  runtimes: z.array(RuntimeInfoSchema),
  /** Project repos this workstation holds a clone of. */
  repos: z.array(z.object({ projectRepoId: z.uuid(), localPath: z.string(), reportedAt: IsoTime })),
  pairedAt: IsoTime,
  /** M3: what this workstation's DevOps engineer may do without asking, and who it is. */
  devopsAccess: DevOpsAccessSchema.optional(),
  devopsAgentId: z.uuid().nullable().optional(),
  hygiene: WorkstationHygieneSchema.optional(),
  /**
   * What the runner found when it last checked the rights ticked on the DevOps engineer (null: never checked, or
   * nothing ticked). `stale`: the ticks changed since.
   */
  rights: RightsReportSchema.extend({ stale: z.boolean().default(false) })
    .nullable()
    .optional(),
  /** The sudo password: whether one is stored on the runner and the key it is encrypted with (never the password). */
  sudo: z
    .object({
      keyId: z.string().nullable(),
      passwordSet: z.boolean(),
      setAt: IsoTime.nullable(),
      works: z.boolean().nullable(),
    })
    .optional(),
  /** Shifts running now and how many this workstation takes at once (`limit` is null while it is offline). */
  shifts: z
    .object({ running: z.number().int().nonnegative(), limit: z.number().int().positive().nullable() })
    .optional(),
});
export type WorkstationDto = z.infer<typeof WorkstationDtoSchema>;
export const WorkstationsResponseSchema = z.object({ workstations: z.array(WorkstationDtoSchema) });

/** `GET /api/workstations/:id/sudo-key`: the public key to encrypt the sudo password with (RSA-OAEP, SHA-256). */
export const SudoKeyResponseSchema = z.object({ keyId: z.string(), publicKey: z.string() });
export type SudoKeyResponse = z.infer<typeof SudoKeyResponseSchema>;
/** `PUT /api/workstations/:id/sudo-password`: the password encrypted in the browser; the server cannot read it. */
export const SetSudoPasswordRequestSchema = z.object({
  ciphertext: z.string().min(1).max(2000),
  keyId: z.string().min(1).max(64),
});
export type SetSudoPasswordRequest = z.infer<typeof SetSudoPasswordRequestSchema>;

export const PatchWorkstationRequestSchema = z.object({ name: z.string().min(1).max(80) });

/** `POST /api/workstations/pairing-codes` -> `XXXX-XXXX` (Crockford base32), shown once, 10 min TTL. */
export const PairingCodeResponseSchema = z.object({ code: z.string(), expiresAt: IsoTime });
export type PairingCodeResponse = z.infer<typeof PairingCodeResponseSchema>;
export const PAIRING_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** `POST /api/runner/pair` (unauthenticated). */
export const RunnerPairRequestSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1).max(80),
  platform: z.string(),
  hostname: z.string(),
  runnerVersion: z.string(),
});
export type RunnerPairRequest = z.infer<typeof RunnerPairRequestSchema>;
export const RunnerPairResponseSchema = z.object({
  workstationId: z.uuid(),
  /** `aomr_` + 32 random bytes base64url. */
  runnerToken: z.string().startsWith('aomr_'),
});
export type RunnerPairResponse = z.infer<typeof RunnerPairResponseSchema>;
