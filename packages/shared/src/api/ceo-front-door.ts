import { z } from 'zod';
import { CeoPermissionDecision, type CeoTurnMode, type RepeatSuggestion } from '../ceo/turns.ts';
import { ModelChoiceSchema } from '../models/choices.ts';

/**
 * The CEO as the owner's front door (docs/design/ceo-front-door.md, step 1): the CEO chat as a full session, the model
 * switch, permission questions, inline confirmations, corrections, the job log and standing orders with full power.
 */

/** Whether the CEO's full-power profile can run on its workstation. */
export type CeoFullPowerState =
  /** The runner announced `ceo-full-power:1` (the machine owner ran `aom-runner ceo full-power on`). */
  | 'on'
  /** The workstation is connected but the local switch is off: turns run restricted. */
  | 'off'
  /** The workstation is offline: the state is not known (messages queue). */
  | 'unknown'
  /** The CEO has no workstation yet. */
  | 'unbound';

export interface CeoChatStateDto {
  threadId: string;
  agentName: string;
  workstation: { id: string; name: string; online: boolean } | null;
  fullPower: { state: CeoFullPowerState; workstationName: string | null };
  /** The conversation's model: the default, the thread override, and the runtimes the workstation reports (for the menu). */
  model: {
    default: z.infer<typeof ModelChoiceSchema>;
    thread: z.infer<typeof ModelChoiceSchema> | null;
    runtimes: string[];
  };
  cwd: string;
  /** A reply is being written right now. */
  busy: boolean;
  /** Messages that wait for the workstation (oldest first); a stale one asks "Send / Drop". */
  queued: Array<{
    turnId: string;
    messageId: string | null;
    body: string;
    queuedAt: IsoTime;
    stale: boolean;
  }>;
  /** Open "authorize this execution" questions of this conversation's turns. */
  permissions: CeoPermissionDto[];
  /** Owner-turn recommendations that wait for an inline Approve / No. */
  confirmations: Array<{
    actionId: string;
    deskItemId: string;
    title: string;
    reason: string;
    turnId: string | null;
  }>;
  /** Corrections recorded in this conversation, newest first (the chat shows them as "Noted: ..." cards). */
  corrections: CeoCorrectionDto[];
}
type IsoTime = string;

export interface CeoPermissionDto {
  askId: string;
  deskItemId: string;
  turnId: string;
  mode: z.infer<typeof CeoTurnMode>;
  tool: string;
  input: string;
  reason: string;
  askedAt: IsoTime;
  /** The question becomes a Deny at this time. */
  expiresAt: IsoTime;
}

export const SetThreadModelRequestSchema = z.object({ choice: ModelChoiceSchema.nullable() });
export const AnswerPermissionRequestSchema = z.object({
  decision: CeoPermissionDecision.exclude(['timeout']),
});
export const AskIdParamsSchema = z.object({ id: z.uuid() });
/** `POST /api/ceo/queue/:id` (the turn id): send a stale queued message anyway, or drop it. */
export const QueuedTurnDecisionSchema = z.object({ decision: z.enum(['send', 'drop']) });
/** `POST /api/ceo/turns/:id/confirm`: the Owner's own answer to an inline confirmation card. */
export const ConfirmTurnRequestSchema = z.object({ actionId: z.uuid(), approve: z.boolean() });

export const CorrectCeoRequestSchema = z
  .object({
    /** What is corrected: one of these. */
    actionId: z.uuid().optional(),
    orderTurnId: z.uuid().optional(),
    chatMessageId: z.uuid().optional(),
    deskItemId: z.uuid().optional(),
    /** "What should I have done?" in the owner's words. */
    text: z.string().trim().min(3).max(4000),
    /** "Make it a rule for next time": the rule (absent: the text itself is the rule). */
    rule: z.string().trim().min(3).max(1000).optional(),
    /** `undo`: take the action back; `redo`: run the corrected call (`redo`) instead. */
    remedy: z.enum(['none', 'undo', 'redo']).default('none'),
    redo: z.object({ action: z.string().min(1), params: z.record(z.string(), z.unknown()) }).optional(),
    /** Unchecked "Make it a rule" records the correction without a memory. */
    makeRule: z.boolean().default(true),
  })
  .refine((v) => v.actionId || v.orderTurnId || v.chatMessageId || v.deskItemId || v.text, {
    message: 'say what is corrected',
  })
  .refine((v) => v.remedy !== 'redo' || !!v.redo, {
    message: 'redo needs the corrected call',
    path: ['redo'],
  });
export type CorrectCeoRequest = z.infer<typeof CorrectCeoRequestSchema>;

export interface CeoCorrectionDto {
  id: string;
  at: IsoTime;
  text: string;
  rule: string;
  memoryId: string | null;
  actionId: string | null;
  orderTurnId: string | null;
  chatMessageId: string | null;
  deskItemId: string | null;
  remedy: 'none' | 'undo' | 'redo';
  /** Undo or Redo is still on offer for the corrected action. */
  canUndo: boolean;
  canRedo: boolean;
}
export const EditCorrectionRequestSchema = z.object({ rule: z.string().trim().min(3).max(1000) });
export const CorrectCeoResponseSchema = z.object({
  correctionId: z.uuid(),
  memoryId: z.uuid().nullable(),
  message: z.string(),
  /** What the remedy did ("Undone: ...", "Redone: ..."), when one was chosen. */
  remedyResult: z.string().nullable(),
});

export interface CeoRepeatDto {
  id: string;
  key: string;
  suggestion: z.infer<typeof RepeatSuggestion>;
  count7: number;
  count30: number;
  projectKey: string | null;
  jobs: Array<{ id: string; title: string; at: IsoTime }>;
  detectedAt: IsoTime;
}
export const ResolveRepeatRequestSchema = z.object({
  decision: z.enum(['dismissed', 'feature', 'skill', 'automation']),
});

/** One `order` turn, for the Activity tab and the daily report ("I'd rather you didn't" is a correction on it). */
export interface CeoOrderTurnDto {
  turnId: string;
  at: IsoTime;
  entryId: string;
  orderTitle: string;
  outcome: 'running' | 'done' | 'declined' | 'failed';
  summary: string;
  commands: string[];
  ask: string | null;
  corrected: boolean;
}
