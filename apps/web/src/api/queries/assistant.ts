import { PlatformAssistantSchema } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../client.ts';

const key = ['platform', 'assistant'] as const;

/** The landing-page assistant's switch and today's numbers (super admin). */
export function usePlatformAssistant() {
  return useQuery({ queryKey: key, queryFn: () => get('/platform/assistant', PlatformAssistantSchema) });
}

export function useSetPlatformAssistant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: boolean | { enabled?: boolean; dailyCapUsd?: number | null }) =>
      put(
        '/platform/assistant',
        typeof body === 'boolean' ? { enabled: body } : body,
        PlatformAssistantSchema,
      ),
    onSuccess: (a) => qc.setQueryData(key, a),
  });
}
