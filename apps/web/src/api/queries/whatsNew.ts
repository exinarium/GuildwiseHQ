import { type MeResponse, MeResponseSchema } from '@aom/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { put } from '../client.ts';
import { meKey } from './auth.ts';

/** Marks "What's new" entries as seen (kept per user on the server). The cached `me` follows at once, so the popup closes. */
export function useMarkWhatsNewSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entryIds: string[]) =>
      put<MeResponse>('/auth/whats-new-seen', { entryIds }, MeResponseSchema),
    onMutate: (entryIds) => {
      qc.setQueryData<MeResponse | null>(meKey, (me) =>
        me
          ? {
              ...me,
              user: {
                ...me.user,
                whatsNewSeen: [...new Set([...(me.user.whatsNewSeen ?? []), ...entryIds])],
              },
            }
          : me,
      );
    },
  });
}
