import {
  type AddPlatformBlockRequest,
  type PlatformBlockEntry,
  type PlatformBlocklistResponse,
  PlatformBlocklistResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from '../client.ts';

/** The owner's block list (R1), on the Security page of the platform area. */
const KEY = ['platform', 'blocklist'] as const;

export function usePlatformBlocklist() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<PlatformBlockEntry[]> =>
      (await get('/platform/blocklist', PlatformBlocklistResponseSchema)).entries,
  });
}

export function useAddPlatformBlock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: AddPlatformBlockRequest) => post<PlatformBlocklistResponse>('/platform/blocklist', b),
    onSuccess: (r) => qc.setQueryData(KEY, r.entries),
  });
}

export function useRemovePlatformBlock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del<PlatformBlocklistResponse>(`/platform/blocklist/${id}`),
    onSuccess: (r) => qc.setQueryData(KEY, r.entries),
  });
}
