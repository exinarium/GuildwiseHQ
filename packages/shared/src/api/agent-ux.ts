import { z } from 'zod';
import { AgentDraftDtoSchema, AgentDraftSchema } from '../agent-ux/draft.ts';
import { HireAgentRequestSchema } from './agents.ts';

/** `GET|PUT /api/agents/:id/mention-policy`: may project members mention this agent in a card comment? */
export const MentionPolicySchema = z.object({ allowMembers: z.boolean() });
export type MentionPolicy = z.infer<typeof MentionPolicySchema>;

/** `GET /api/cards/:id/mentionable`: the agents the viewer may mention on this card, for the comment box. */
export const MentionableAgentSchema = z.object({
  agentId: z.uuid(),
  name: z.string(),
  handle: z.string(),
  roleKey: z.string(),
});
export type MentionableAgentDto = z.infer<typeof MentionableAgentSchema>;
export const MentionableResponseSchema = z.object({ agents: z.array(MentionableAgentSchema) });

/** What the comment answer says about each mention in it. */
export const MentionResultSchema = z.object({
  handle: z.string(),
  agentName: z.string(),
  status: z.enum(['started', 'refused']),
  reason: z.string().optional(),
});
export type MentionResult = z.infer<typeof MentionResultSchema>;

/** `POST /api/agents/draft`: one sentence, to be drafted by an agent turn. */
export const AgentDraftRequestSchema = z.object({
  description: z.string().trim().min(3).max(600),
  projectId: z.uuid().optional(),
  workstationId: z.uuid().optional(),
  /** Optional: the model the drafting turn runs on (default: the Analyst's own). */
  runtime: z.string().max(60).optional(),
  model: z.string().max(100).optional(),
});
export type AgentDraftRequest = z.infer<typeof AgentDraftRequestSchema>;
export const AgentDraftStartedSchema = z.object({ threadId: z.uuid() });

/** `GET /api/agents/draft/:threadId`. */
export const AgentDraftStatusSchema = z.object({
  status: z.enum(['working', 'ready', 'failed']),
  draft: AgentDraftDtoSchema.optional(),
  error: z.string().optional(),
});
export type AgentDraftStatus = z.infer<typeof AgentDraftStatusSchema>;

/** `POST /api/agents/draft/clamp`: the review step shows what the hirer's authority allows for the edited draft. */
export const ClampDraftRequestSchema = z.object({ draft: AgentDraftSchema });
export const ClampDraftResponseSchema = z.object({ draft: AgentDraftDtoSchema });

/** `POST /api/agents/hire-from-draft`: the normal hire fields, with the (possibly edited) draft in place of a role. */
export const HireFromDraftRequestSchema = HireAgentRequestSchema.omit({ roleKey: true }).extend({
  draft: AgentDraftSchema,
  /** The starter gallery entry the draft came from, for the role's note. */
  starterKey: z.string().max(130).optional(),
});
export type HireFromDraftRequest = z.infer<typeof HireFromDraftRequestSchema>;

/** `GET /api/starter-gallery`. */
export const StarterGalleryEntrySchema = z.object({
  kind: z.enum(['persona', 'playbook']),
  key: z.string(),
  title: z.string(),
  outcome: z.string(),
  group: z.string(),
});
export const StarterGalleryResponseSchema = z.object({
  entries: z.array(StarterGalleryEntrySchema),
  /** An empty organization (no agent hired and no session yet): the gallery is shown as the first step. */
  firstRun: z.boolean(),
});
export type StarterGalleryResponse = z.infer<typeof StarterGalleryResponseSchema>;
/** `GET /api/starter-gallery/:key/draft`: a starter persona as a draft for the review step. */
export const StarterDraftResponseSchema = z.object({ draft: AgentDraftDtoSchema });

/** `GET|PUT /api/org/follow-up`: the chase window of the active organization (0 is off). */
export const FollowUpSettingsSchema = z.object({ days: z.number().int().min(0).max(30) });
export type FollowUpSettings = z.infer<typeof FollowUpSettingsSchema>;

/** `POST /api/desk/:id/snooze`. */
export const SnoozeRequestSchema = z.object({ days: z.number().int().min(1).max(14) });
export type SnoozeRequest = z.infer<typeof SnoozeRequestSchema>;
