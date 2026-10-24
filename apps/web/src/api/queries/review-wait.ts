import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { get } from '../client.ts';

/** Q67: the reviewer asked to read an authored pack while its author's workstation is offline: the review waits for it. */
const ReviewWaitSchema = z.object({
  waiting: z.boolean(),
  workstationName: z.string().optional(),
  since: z.string().optional(),
});
export type ReviewWait = z.infer<typeof ReviewWaitSchema>;

/** Polled while the read is pending; the server tells the reviewer on their desk when the workstation connects. */
export function useReviewWait(packId: string, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ['packs', 'review-wait', packId],
    queryFn: (): Promise<ReviewWait> => get(`/packs/${packId}/review-wait`, ReviewWaitSchema),
    retry: false,
    refetchInterval: 5000,
  });
}
