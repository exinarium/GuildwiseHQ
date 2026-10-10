import {
  type CreateOrgInvitationRequest,
  type OrgDetailResponse,
  OrgDetailResponseSchema,
  type OrgGuestDto,
  OrgGuestsResponseSchema,
  OrgInvitationsResponseSchema,
  type OrgMemberDto,
  OrgMembersResponseSchema,
  type OrgRemovalPreview,
  OrgRemovalPreviewSchema,
  type OrgsResponse,
  OrgsResponseSchema,
  type PatchOrgRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put } from '../client.ts';
import { meKey } from './auth.ts';

export const orgKey = ['org'] as const;

/** The organization of this tab (any member). Limits and usage come back for the Owner and Admins only. */
export function useOrg(enabled = true) {
  return useQuery({
    queryKey: orgKey,
    enabled,
    queryFn: () => get<OrgDetailResponse>('/org', OrgDetailResponseSchema),
  });
}

export function useOrgs() {
  return useQuery({ queryKey: ['orgs'], queryFn: () => get<OrgsResponse>('/orgs', OrgsResponseSchema) });
}

function refresh(qc: ReturnType<typeof useQueryClient>) {
  for (const k of ['org', 'org-members', 'org-invitations', 'org-guests', 'orgs', 'me', 'projects', 'agents'])
    void qc.invalidateQueries({ queryKey: [k] });
}

export function usePatchOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: PatchOrgRequest) => patch<OrgDetailResponse>('/org', b, OrgDetailResponseSchema),
    onSuccess: () => refresh(qc),
  });
}

export function useOrgMembers() {
  return useQuery({
    queryKey: ['org-members'],
    queryFn: async () => (await get('/org/members', OrgMembersResponseSchema)).members,
  });
}

export function useChangeMemberRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { userId: string; role: 'admin' | 'member' }) =>
      patch(`/org/members/${b.userId}`, { role: b.role }),
    onSuccess: () => refresh(qc),
  });
}

export function useSetMemberProjects() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { userId: string; projectIds: string[] }) =>
      put(`/org/members/${b.userId}/projects`, { projectIds: b.projectIds }),
    onSuccess: () => refresh(qc),
  });
}

export function useRemovalPreview(userId: string | null) {
  return useQuery({
    queryKey: ['org-members', 'removal', userId],
    enabled: !!userId,
    queryFn: () => get<OrgRemovalPreview>(`/org/members/${userId}/removal-preview`, OrgRemovalPreviewSchema),
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => del(`/org/members/${userId}`),
    onSuccess: () => refresh(qc),
  });
}

export function useLeaveOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => del('/org/members/me'),
    onSuccess: () => {
      refresh(qc);
      void qc.invalidateQueries({ queryKey: meKey });
    },
  });
}

export function useTransferOwnership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { userId: string; password: string }) => post('/org/transfer-ownership', b),
    onSuccess: () => refresh(qc),
  });
}

export function useResetMemberTwoFactor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => post(`/org/members/${userId}/reset-two-factor`, {}),
    onSuccess: () => refresh(qc),
  });
}

/** The temporary password comes back in this response only: show it once, never store it. */
export function useResetMemberPassword() {
  return useMutation({
    mutationFn: (userId: string) =>
      post<{ temporaryPassword: string }>(`/org/members/${userId}/reset-password`, {}),
  });
}

export function useOrgInvitations() {
  return useQuery({
    queryKey: ['org-invitations'],
    queryFn: async () => (await get('/org/invitations', OrgInvitationsResponseSchema)).invitations,
  });
}

export function useInviteMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: CreateOrgInvitationRequest) => post('/org/invitations', b),
    onSuccess: () => refresh(qc),
  });
}

export function useResendOrgInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post(`/org/invitations/${id}/resend`, {}),
    onSuccess: () => refresh(qc),
  });
}

export function useRevokeOrgInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post(`/org/invitations/${id}/revoke`, {}),
    onSuccess: () => refresh(qc),
  });
}

export function useOrgGuests(enabled = true) {
  return useQuery({
    queryKey: ['org-guests'],
    enabled,
    queryFn: async () => (await get('/org/guests', OrgGuestsResponseSchema)).guests,
  });
}

export type { OrgGuestDto, OrgMemberDto };
