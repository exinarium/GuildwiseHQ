import {
  type FailedSignInsResponse,
  FailedSignInsResponseSchema,
  type SignInsResponse,
  SignInsResponseSchema,
} from '@aom/shared';
import { useQuery } from '@tanstack/react-query';
import { get } from '../client.ts';

/** Platform > Security: failed sign-ins (with the locks in force) and successful sign-ins (R2, R4). */
const qs = (q: string) => (q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '');

export function useFailedSignIns(q: string) {
  return useQuery({
    queryKey: ['platform', 'security', 'failed-sign-ins', q.trim()],
    queryFn: () =>
      get<FailedSignInsResponse>(`/platform/security/failed-sign-ins${qs(q)}`, FailedSignInsResponseSchema),
  });
}

export function useSignIns(q: string) {
  return useQuery({
    queryKey: ['platform', 'security', 'sign-ins', q.trim()],
    queryFn: () => get<SignInsResponse>(`/platform/security/sign-ins${qs(q)}`, SignInsResponseSchema),
  });
}
