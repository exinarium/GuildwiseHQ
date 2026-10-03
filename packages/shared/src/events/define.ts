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
});
export type Usage = z.infer<typeof Usage>;

export const UserRole = z.enum(['admin', 'member']);
export type UserRole = z.infer<typeof UserRole>;
