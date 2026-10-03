import {
  AdminInvitationsResponseSchema,
  AdminUsersResponseSchema,
  AdminWorkstationsResponseSchema,
  type CreateInvitationRequest,
  type PairingCodeResponse,
  PairingCodeResponseSchema,
  type PatchUserRequest,
  WorkstationsResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post } from '../client.ts';

export function useWorkstations() {
  return useQuery({
    queryKey: ['workstations'],
    queryFn: async () => (await get('/workstations', WorkstationsResponseSchema)).workstations,
  });
}

export function usePairingCode() {
  return useMutation({
    mutationFn: () => post<PairingCodeResponse>('/workstations/pairing-codes', {}, PairingCodeResponseSchema),
  });
}

export function useUnlinkWorkstation(admin = false) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      post(admin ? `/admin/workstations/${id}/unlink` : `/workstations/${id}/unlink`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workstations'] });
      qc.invalidateQueries({ queryKey: ['admin'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export function useRenameWorkstation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; name: string }) => patch(`/workstations/${v.id}`, { name: v.name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workstations'] }),
  });
}

export const useAdminUsers = () =>
  useQuery({
    queryKey: ['admin', 'users'],
    queryFn: async () => (await get('/admin/users', AdminUsersResponseSchema)).users,
  });
export const useAdminInvitations = () =>
  useQuery({
    queryKey: ['admin', 'invitations'],
    queryFn: async () => (await get('/admin/invitations', AdminInvitationsResponseSchema)).invitations,
  });
export const useAdminWorkstations = () =>
  useQuery({
    queryKey: ['admin', 'workstations'],
    queryFn: async () => (await get('/admin/workstations', AdminWorkstationsResponseSchema)).workstations,
  });

export function useAdminMutations() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ['admin'] });
  return {
    invite: useMutation({
      mutationFn: (b: CreateInvitationRequest) => post('/admin/invitations', b),
      onSuccess: done,
    }),
    resend: useMutation({
      mutationFn: (id: string) => post(`/admin/invitations/${id}/resend`),
      onSuccess: done,
    }),
    revoke: useMutation({
      mutationFn: (id: string) => post(`/admin/invitations/${id}/revoke`),
      onSuccess: done,
    }),
    patchUser: useMutation({
      mutationFn: (v: { id: string; body: PatchUserRequest }) => patch(`/admin/users/${v.id}`, v.body),
      onSuccess: done,
    }),
  };
}
