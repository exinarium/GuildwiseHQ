import { z } from 'zod';

/** `end` is reserved: a handoff to it completes the instance. */
export const StepIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/);
export const Position = z.object({ x: z.number(), y: z.number() });
