import {
  type AcceptExistingInvitationRequest,
  type AcceptInvitationRequest,
  InvitationInfoResponseSchema,
  type Login2faRequest,
  type LoginChallengeResponse,
  type LoginRequest,
  type MeResponse,
  MeResponseSchema,
  type RecoveryCodesResponse,
  type SetMyAvatarRequest,
  type TwoFactorSetupResponse,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getActiveOrgId, setActiveOrgId } from '../../lib/activeOrg.ts';
import { getSocket } from '../../ws/socket.ts';
import { ApiError, get, post, put } from '../client.ts';

export const meKey = ['me'] as const;

/**
 * Keeps this tab's organization consistent with what the server resolved: a tab without one (or with one the user left)
 * takes the server's choice; a platform account has none.
 */
export function syncActiveOrg(me: MeResponse | null): void {
  if (!me || me.account?.kind === 'super_admin') {
    setActiveOrgId(null);
    return;
  }
  const current = getActiveOrgId();
  if (me.activeOrg && me.activeOrg.id !== current) setActiveOrgId(me.activeOrg.id);
  else if (!me.activeOrg && current) setActiveOrgId(null);
}

/** `null` when not signed in (401). */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async (): Promise<MeResponse | null> => {
      try {
        const me = await get<MeResponse>('/auth/me', MeResponseSchema);
        syncActiveOrg(me);
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

/** `POST /api/auth/login`: a session (`me`), or - two-factor accounts - a challenge to answer with a code. */
export type LoginResult =
  | { kind: 'me'; me: MeResponse }
  | { kind: 'challenge'; challenge: LoginChallengeResponse };

function startSession(qc: ReturnType<typeof useQueryClient>, me: MeResponse) {
  // A new session starts clean: nothing cached for another account or organization survives.
  qc.clear();
  setActiveOrgId(null);
  syncActiveOrg(me);
  qc.setQueryData(meKey, me);
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: LoginRequest): Promise<LoginResult> => {
      const r = await post<MeResponse | LoginChallengeResponse>('/auth/login', b);
      if ('twoFactorRequired' in r) return { kind: 'challenge', challenge: r };
      return { kind: 'me', me: r };
    },
    onSuccess: (r) => {
      if (r.kind === 'me') startSession(qc, r.me);
    },
  });
}

/** The second step of a two-factor login: a 6-digit code or a recovery code. */
export function useLogin2fa() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: Login2faRequest) => post<MeResponse>('/auth/login/2fa', b, MeResponseSchema),
    onSuccess: (me) => startSession(qc, me),
  });
}

/** Switches this tab to another organization: remembered on the server, kept per tab, caches and socket reset. */
export function useSwitchOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orgId: string) => {
      setActiveOrgId(orgId);
      return post<MeResponse>('/orgs/active', { orgId }, MeResponseSchema);
    },
    onSuccess: (me) => {
      qc.clear();
      syncActiveOrg(me);
      qc.setQueryData(meKey, me);
      getSocket()?.restart();
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post('/auth/logout'),
    onSuccess: () => {
      qc.clear();
      setActiveOrgId(null);
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
    onSuccess: (me) => startSession(qc, me),
  });
}

/** Signed in with the invited email: join the organization (or create the invited one) without a new account. */
export function useAcceptExistingInvitation(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: AcceptExistingInvitationRequest) =>
      post<MeResponse>(`/invitations/${encodeURIComponent(token)}/accept-existing`, b, MeResponseSchema),
    onSuccess: (me) => {
      qc.clear();
      // The organization just joined or created becomes this tab's.
      setActiveOrgId(me.activeOrg?.id ?? null);
      qc.setQueryData(meKey, me);
      getSocket()?.restart();
    },
  });
}

// ---- two-factor login (owner decision 7)

export interface TwoFactorStatus {
  enabled: boolean;
  required: boolean;
  setupRequired: boolean;
  recoveryCodesLeft: number;
  requiredBy: Array<{ id: string; name: string }>;
}

export const twoFactorKey = ['two-factor'] as const;

export function useTwoFactorStatus() {
  return useQuery({ queryKey: twoFactorKey, queryFn: () => get<TwoFactorStatus>('/auth/2fa') });
}

export function useTwoFactorSetup() {
  return useMutation({
    mutationFn: (password: string) => post<TwoFactorSetupResponse>('/auth/2fa/setup', { password }),
  });
}

export function useEnableTwoFactor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => post<RecoveryCodesResponse>('/auth/2fa/enable', { code }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: meKey });
      void qc.invalidateQueries({ queryKey: twoFactorKey });
    },
  });
}

export function useDisableTwoFactor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { password: string; code: string }) => post('/auth/2fa/disable', b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: meKey });
      void qc.invalidateQueries({ queryKey: twoFactorKey });
    },
  });
}

export function useRegenerateRecoveryCodes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { password: string; code: string }) =>
      post<RecoveryCodesResponse>('/auth/2fa/recovery-codes', b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: twoFactorKey }),
  });
}

/** Your own picture: a generated face, an uploaded or photographed image (a cropped PNG), or none. */
export function useSetMyAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: SetMyAvatarRequest) => put<MeResponse>('/me/avatar', b, MeResponseSchema),
    onSuccess: (me) => {
      qc.setQueryData(meKey, me);
      // desk answers and the admin list show it too
      for (const key of ['desk', 'admin']) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

// ---- forgot password: request a link, check it, set the new password
export function useRequestPasswordReset() {
  return useMutation({
    mutationFn: (email: string) => post('/auth/password-reset/request', { email }),
  });
}

export function useResetLinkValid(token: string) {
  return useQuery({
    queryKey: ['password-reset', token],
    queryFn: () => get<{ valid: boolean }>(`/auth/password-reset/${encodeURIComponent(token)}`),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** The signed-in user changes their own password (also the forced change after an Owner's temporary password). */
export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { current: string; new: string }) => post('/auth/password', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
  });
}

export function useConfirmPasswordReset() {
  return useMutation({
    mutationFn: (v: { token: string; password: string }) => post('/auth/password-reset/confirm', v),
  });
}
