import { type MeResponse, MeResponseSchema, type UpdateTourRequest } from '@aom/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { put } from '../client.ts';
import { meKey } from './auth.ts';

/**
 * Saves are sent one after the other: concurrent requests (a quick run of Next clicks) could be committed out of
 * order, leaving an earlier step as the final state, and a late response must not overwrite a newer choice.
 */
let queue: Promise<unknown> = Promise.resolve();
let pending = 0;

/** Saves where the user is in the first-login tour (kept per user on the server). The cached `me` follows at once. */
export function useSetTour() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: UpdateTourRequest) => {
      pending++;
      const run = queue.then(async () => {
        try {
          return await put<MeResponse>('/auth/tour', b, MeResponseSchema);
        } catch {
          return put<MeResponse>('/auth/tour', b, MeResponseSchema); // one retry: a lost save brings the tour back
        } finally {
          pending--;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
    onMutate: (b) => {
      qc.setQueryData<MeResponse | null>(meKey, (me) =>
        me ? { ...me, user: { ...me.user, tour: { status: b.status, step: b.step } } } : me,
      );
    },
    onSuccess: (me) => {
      if (pending === 0) qc.setQueryData(meKey, me);
    },
  });
}
