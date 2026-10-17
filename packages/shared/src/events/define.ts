import { z } from 'zod';

export const defineEvent = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ type: z.literal(type), payload });

export const Id = z.uuid();
export const Stage = z.string().min(1);
export const Note = z.string().min(1).max(20000);
export const IsoDate = z.iso.datetime();

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  /** Of the cache writes, the tokens written with the 1-hour TTL (2x the input price instead of 1.25x); absent: all 5-minute. */
  cacheWrite1hTokens: z.number().int().nonnegative().optional(),
  /** The model that did the work when the runtime says (Claude Code `modelUsage`); else the agent's configured one. */
  model: z.string().max(120).optional(),
  /** What the runtime itself reported as cost in USD (Claude Code `total_cost_usd`); informational. */
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const UserRole = z.enum(['admin', 'member']);
export type UserRole = z.infer<typeof UserRole>;
