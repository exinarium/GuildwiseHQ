import { z } from 'zod';

/** `{error:{code,message,details?}}` for 400 validation, 401, 403, 404 (also "exists but not yours"), 409, 422, 429. */
export const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const OkResponseSchema = z.object({ ok: z.literal(true) });
export const IdParamsSchema = z.object({ id: z.uuid() });
export const IsoTime = z.iso.datetime();

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  db: z.boolean(),
  version: z.string().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
