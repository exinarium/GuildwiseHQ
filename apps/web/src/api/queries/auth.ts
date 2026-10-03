import {
  type AcceptInvitationRequest,
  InvitationInfoResponseSchema,
  type LoginRequest,
  type MeResponse,
  MeResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post } from '../client.ts';

export const meKey = ['me'] as const;

/** `null` when not signed in (401). */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async (): Promise<MeResponse | null> => {
      try {
        return await get('/auth/me', MeResponseSchema);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: LoginRequest) => post<MeResponse>('/auth/login', b, MeResponseSchema),
    onSuccess: (me) => qc.setQueryData(meKey, me),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post('/auth/logout'),
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(meKey, null);
    },
  });
}

export function useInvitation(token: string) {
  return useQuery({
    queryKey: ['invitation', token],
    queryFn: () => get(`/invitations/${encodeURIComponent(token)}`, InvitationInfoResponseSchema),
    retry: false,
  });
}

export function useAcceptInvitation(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: AcceptInvitationRequest) =>
      post<MeResponse>(`/invitations/${encodeURIComponent(token)}/accept`, b, MeResponseSchema),
    onSuccess: (me) => qc.setQueryData(meKey, me),
  });
}
