import { z } from 'zod';
import { ApprovalPasskeyPayloadSchema, HeldItemSchema, LocalStepSchema } from '../protocol/security.ts';
import { PasskeyAlgSchema } from '../security/index.ts';
import { IsoTime } from './common.ts';

/*
 * Passkey approvals on the workstation page (R22, DESIGN R18-S2). The server verifies a registration and relays
 * assertions; it never approves anything itself. The runner trusts a passkey only after a local
 * `guildwise-runner passkey trust`, and checks every assertion on its own.
 */

/** A passkey registered for one workstation (active ones only). */
export const WorkstationPasskeyDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** base64url credential id (shown shortened; `passkey trust` on the machine prints the same prefix). */
  credentialId: z.string(),
  alg: PasskeyAlgSchema,
  createdAt: IsoTime,
});
export type WorkstationPasskeyDto = z.infer<typeof WorkstationPasskeyDtoSchema>;

export const WorkstationPasskeysResponseSchema = z.object({
  passkeys: z.array(WorkstationPasskeyDtoSchema),
  /** The WebAuthn relying party id (the server host) and the one origin passkeys are made and used on. */
  rpId: z.string(),
  origin: z.string(),
});
export type WorkstationPasskeysResponse = z.infer<typeof WorkstationPasskeysResponseSchema>;

/**
 * `POST /api/workstations/:id/passkeys/options`: the WebAuthn creation options (`PublicKeyCredentialCreationOptionsJSON`)
 * and a short-lived server-signed token that binds the challenge to this user and workstation.
 */
export const PasskeyRegistrationOptionsResponseSchema = z.object({
  options: z.record(z.string(), z.unknown()),
  registrationToken: z.string().min(1).max(512),
});
export type PasskeyRegistrationOptionsResponse = z.infer<typeof PasskeyRegistrationOptionsResponseSchema>;

/** `POST /api/workstations/:id/passkeys`: the browser's `RegistrationResponseJSON` plus a name for the passkey. */
export const AddPasskeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  registrationToken: z.string().min(1).max(512),
  response: z.looseObject({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: z.looseObject({
      clientDataJSON: z.string().min(1).max(8192),
      attestationObject: z.string().min(1).max(16384),
    }),
  }),
});
export type AddPasskeyRequest = z.infer<typeof AddPasskeyRequestSchema>;

/** A held item as the approvals page shows it; `passkey` is present only for a passkey kind with a trusted passkey. */
export const ApprovalItemDtoSchema = HeldItemSchema.extend({
  /** True when the browser may offer "Approve with passkey" (the runner still decides). */
  passkeyApprovable: z.boolean(),
});
export type ApprovalItemDto = z.infer<typeof ApprovalItemDtoSchema>;

/** The last relayed passkey assertions of this workstation and what the runner answered. */
export const PasskeyRelayDtoSchema = z.object({
  commandId: z.string(),
  itemId: z.string(),
  status: z.enum(['sent', 'refused', 'accepted', 'expired']),
  /** The runner's refusal, shown as plain text. */
  error: z.string().nullable(),
  at: IsoTime,
});
export type PasskeyRelayDto = z.infer<typeof PasskeyRelayDtoSchema>;

/** `GET /api/workstations/:id/approvals`: what the runner holds right now (its last report on the live connection). */
export const WorkstationApprovalsResponseSchema = z.object({
  online: z.boolean(),
  /** When the runner last reported its held items on this connection (null: not since it connected). */
  reportedAt: IsoTime.nullable(),
  items: z.array(ApprovalItemDtoSchema),
  relays: z.array(PasskeyRelayDtoSchema),
  /** easy-runner-setup: local steps waiting on the workstation, each with its copy-paste command. */
  steps: z.array(LocalStepSchema).optional(),
  /** The approvals page on the workstation, when it runs (`http://127.0.0.1:<port>/`). */
  windowPort: z.number().int().nullable().optional(),
});
export type WorkstationApprovalsResponse = z.infer<typeof WorkstationApprovalsResponseSchema>;

/** `POST /api/workstations/:id/approvals/:itemId/passkey`: the WebAuthn assertion to relay to the runner. */
export const PasskeyApprovalRequestSchema = ApprovalPasskeyPayloadSchema.omit({ itemId: true });
export type PasskeyApprovalRequest = z.infer<typeof PasskeyApprovalRequestSchema>;

/** 202: relayed, not approved; the item leaves the held list only when the runner accepted the assertion. */
export const PasskeyApprovalResponseSchema = z.object({ relayed: z.literal(true), commandId: z.string() });
export type PasskeyApprovalResponse = z.infer<typeof PasskeyApprovalResponseSchema>;
