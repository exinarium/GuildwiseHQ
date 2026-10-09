import {
  type NewOrgInvitationRequest,
  type OrgStatusActionRequest,
  type PatchPlatformOrgRequest,
  type PlatformAuditResponseSchema,
  PlatformInvitationsResponseSchema,
  type PlatformOrgDetail,
  PlatformOrgDetailSchema,
  type PlatformOrgSummary,
  PlatformOrgsResponseSchema,
  PlatformUsersResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { get, patch, post, qs } from '../client.ts';

export type PlatformAuditResponse = z.infer<typeof PlatformAuditResponseSchema>;

export function usePlatformOrgs(filter: { status?: string; q?: string; sort?: string }) {
  return useQuery({
    queryKey: ['platform', 'orgs', filter],
    queryFn: async (): Promise<PlatformOrgSummary[]> =>
      (await get(`/platform/orgs${qs(filter)}`, PlatformOrgsResponseSchema)).orgs,
  });
}

export function usePlatformOrg(id: string) {
  return useQuery({
    queryKey: ['platform', 'org', id],
    queryFn: () => get<PlatformOrgDetail>(`/platform/orgs/${id}`, PlatformOrgDetailSchema),
  });
}

function refresh(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['platform'] });
}

export function usePatchPlatformOrg(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: PatchPlatformOrgRequest) => patch<PlatformOrgDetail>(`/platform/orgs/${id}`, b),
    onSuccess: () => refresh(qc),
  });
}

export function useOrgStatusAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { action: 'suspend' | 'reactivate' | 'cancel' } & OrgStatusActionRequest) =>
      post<PlatformOrgDetail>(`/platform/orgs/${id}/${b.action}`, { reason: b.reason, note: b.note }),
    onSuccess: () => refresh(qc),
  });
}

export function usePlatformTransfer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { toUserId: string; reason: string }) =>
      post<PlatformOrgDetail>(`/platform/orgs/${id}/transfer-ownership`, b),
    onSuccess: () => refresh(qc),
  });
}

export function usePlatformInvitations() {
  return useQuery({
    queryKey: ['platform', 'invitations'],
    queryFn: async () => (await get('/platform/invitations', PlatformInvitationsResponseSchema)).invitations,
  });
}

export function useInviteNewOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: NewOrgInvitationRequest) => post('/platform/invitations', b),
    onSuccess: () => refresh(qc),
  });
}

export function usePlatformInvitationAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { id: string; action: 'resend' | 'revoke' }) =>
      post(`/platform/invitations/${b.id}/${b.action}`, {}),
    onSuccess: () => refresh(qc),
  });
}

export function usePlatformUsers(q: string) {
  return useQuery({
    queryKey: ['platform', 'users', q],
    queryFn: async () => (await get(`/platform/users${qs({ q })}`, PlatformUsersResponseSchema)).users,
  });
}

export function usePatchPlatformUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { id: string; status: 'active' | 'deactivated' }) =>
      patch(`/platform/users/${b.id}`, { status: b.status }),
    onSuccess: () => refresh(qc),
  });
}

export function useResetUserTwoFactor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post(`/platform/users/${id}/reset-two-factor`, {}),
    onSuccess: () => refresh(qc),
  });
}

export function useSendPasswordReset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      post<{ sentTo: string; expiresAt: string }>(`/platform/users/${id}/send-password-reset`, {}),
    onSuccess: () => refresh(qc),
  });
}

export function usePlatformAudit(filter: {
  orgId?: string;
  actorId?: string;
  action?: string;
  before?: number;
}) {
  return useQuery({
    queryKey: ['platform', 'audit', filter],
    queryFn: () => get<PlatformAuditResponse>(`/platform/audit${qs({ ...filter, limit: 50 })}`),
  });
}
