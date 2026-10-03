import { z } from 'zod';

export const ActorKind = z.enum(['user', 'agent', 'system', 'runner']);
export const Audience = z.enum(['org', 'project', 'admin', 'system']);
export type Audience = z.infer<typeof Audience>;

export const ActorSchema = z.object({ kind: ActorKind, id: z.string().nullable() });
export type Actor = z.infer<typeof ActorSchema>;

export const ScopeSchema = z.object({
  orgId: z.string().nullable(),
  projectId: z.string().nullable(),
  audience: Audience,
});
export type Scope = z.infer<typeof ScopeSchema>;

/** What the browser sees for each event that passes the visibility predicate (section 20). */
export const VisibleEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string(),
  streamId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  actor: ActorSchema,
  projectId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type VisibleEvent = z.infer<typeof VisibleEventSchema>;
