import {
  type ConnectRequest,
  type ConnectSecret,
  type ConnectStartedDto,
  connectSealAad,
  type HostKeyScanRequest,
  type KeyCreateRequest,
  type OpStartedDto,
  type OpStatusDto,
  type PrepareRequest,
  type RevokeKeyRequest,
  sealLarge,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';
import { setupKey } from './deploy-setup.ts';

/**
 * Guided connect (docs/design/deploy-run-ux-design.md v2): scan a server's fingerprint, make this computer's dedicated key,
 * connect with a password / key file (sealed in the browser for the chosen computer's runner, only ciphertext is sent) / a pasted
 * key / an existing sign-in, remove a key Guildwise added, prepare a server, and follow each operation until the computer answers.
 */

const refresh = (qc: ReturnType<typeof useQueryClient>, projectId: string) => {
  void qc.invalidateQueries({ queryKey: setupKey(projectId) });
  void qc.invalidateQueries({ queryKey: ['deploy-targets', projectId] });
};

/** Follows one operation (a command on the chosen computer) until it is answered or expires. */
export function useOp(projectId: string, commandId: string | null | undefined) {
  return useQuery({
    queryKey: ['deploy-op', projectId, commandId],
    enabled: !!commandId,
    queryFn: () => get<OpStatusDto>(`/projects/${projectId}/delivery/ops/${commandId}`),
    refetchInterval: (q) => (q.state.data && q.state.data.state !== 'pending' ? false : 1000),
    retry: false,
  });
}

export const useStartHostKey = (projectId: string) =>
  useMutation({
    mutationFn: (v: HostKeyScanRequest) => post<OpStartedDto>(`/projects/${projectId}/delivery/hostkey`, v),
  });

export const useCreateKey = (projectId: string) =>
  useMutation({
    mutationFn: (v: KeyCreateRequest) => post<OpStartedDto>(`/projects/${projectId}/delivery/key`, v),
  });

export type ConnectInput = Omit<ConnectRequest, 'keyId' | 'ciphertext' | 'port'> & {
  port?: number | undefined;
  /** A password or key file: sealed here for the chosen computer, never sent as text. */
  secret?: ConnectSecret | undefined;
};

export function useConnect(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: ConnectInput) => {
      const { secret, ...rest } = v;
      let sealed: { keyId: string; ciphertext: string } | undefined;
      if (secret) {
        const key = await get<{ keyId: string; publicKey: string; sealAad?: boolean }>(
          `/workstations/${v.workstationId}/sudo-key`,
        );
        // bound to the project and the server it was typed for (a computer that can open that; an older one gets the plain form)
        const aad =
          key.sealAad && v.address && v.user
            ? connectSealAad({ projectId, address: v.address, port: v.port ?? 22, user: v.user })
            : undefined;
        sealed = {
          keyId: key.keyId,
          ciphertext: await sealLarge(key.publicKey, JSON.stringify(secret), aad),
        };
      }
      return post<ConnectStartedDto>(`/projects/${projectId}/delivery/connect`, {
        ...rest,
        port: v.port ?? 22,
        ...(sealed ?? {}),
      });
    },
    onSuccess: () => refresh(qc, projectId),
  });
}

export function useRevokeKey(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { targetId: string } & RevokeKeyRequest) =>
      post<OpStartedDto>(`/projects/${projectId}/delivery/targets/${v.targetId}/revoke-key`, {
        workstationId: v.workstationId,
        fingerprint: v.fingerprint,
      }),
    onSuccess: () => refresh(qc, projectId),
  });
}

export function usePrepare(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: PrepareRequest) => post<OpStartedDto>(`/projects/${projectId}/delivery/prepare`, v),
    onSuccess: () => refresh(qc, projectId),
  });
}

/** "Check connection": can the computer that deploys this server sign in to it now? */
export function useCheckTarget(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (targetId: string) =>
      post<{ commandId: string; workstationId: string }>(
        `/projects/${projectId}/delivery/targets/${targetId}/check`,
      ),
    onSuccess: () => {
      // the answer arrives over the socket; look again shortly in case it was quick
      setTimeout(() => refresh(qc, projectId), 2500);
      setTimeout(() => refresh(qc, projectId), 8000);
    },
  });
}
