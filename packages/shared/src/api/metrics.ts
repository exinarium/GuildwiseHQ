import { z } from 'zod';
import { IsoTime } from './common.ts';

export const MetricsQuerySchema = z.object({
  projectId: z.uuid().optional(),
  from: IsoTime.optional(),
  to: IsoTime.optional(),
});

const DayCount = z.object({ day: z.string(), count: z.number().int() });

/** `GET /api/metrics?projectId=&from=&to=` (manager dashboard, docs/SPEC.md "Manager dashboard"). */
export const MetricsResponseSchema = z.object({
  projectId: z.uuid().nullable(),
  from: IsoTime,
  to: IsoTime,
  /** Cards finalized per day (every day in the range, zero included). */
  throughput: z.array(DayCount),
  timeBlockedOnManager: z.object({
    totalMs: z.number().int(),
    cards: z.number().int(),
    avgMsPerCard: z.number().nullable(),
  }),
  /** Per builder: reviews that bounced and tests that failed over the cards it submitted. */
  bounceRate: z.array(
    z.object({
      agentId: z.uuid(),
      name: z.string(),
      submitted: z.number().int(),
      reviewBounces: z.number().int(),
      testFailures: z.number().int(),
      rate: z.number().nullable(),
    }),
  ),
  bugsEscaped: z.object({ total: z.number().int(), byDay: z.array(DayCount) }),
  duration: z.object({
    cards: z.number().int(),
    avgMsPerCard: z.number().nullable(),
    medianMsPerCard: z.number().nullable(),
    perAgent: z.array(
      z.object({
        agentId: z.uuid(),
        name: z.string(),
        shifts: z.number().int(),
        totalMs: z.number().int(),
        avgMsPerShift: z.number().nullable(),
      }),
    ),
  }),
  /** Cards sitting in each board column now. */
  queueDepth: z.array(z.object({ column: z.string(), count: z.number().int() })),
});
export type MetricsResponse = z.infer<typeof MetricsResponseSchema>;
