import { type MeResponse, MeResponseSchema, type UpdateTourRequest } from '@aom/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { put } from '../client.ts';
import { meKey } from './auth.ts';

/** Saves where the user is in the first-login tour (kept per user on the server). The cached `me` follows at once. */
export function useSetTour() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: UpdateTourRequest) => put<MeResponse>('/auth/tour', b, MeResponseSchema),
    onMutate: (b) => {
      qc.setQueryData<MeResponse | null>(meKey, (me) =>
        me ? { ...me, user: { ...me.user, tour: { status: b.status, step: b.step } } } : me,
      );
    },
    onSuccess: (me) => qc.setQueryData(meKey, me),
  });
}
