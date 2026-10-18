import {
  type PushConfig,
  PushConfigSchema,
  type PushDevices,
  PushDevicesSchema,
  type PushPreferences,
  PushPreferencesSchema,
  type PushPreferencesUpdate,
  type PushTestResult,
  PushTestResultSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../client.ts';

const devicesKey = ['push', 'devices'] as const;
const prefsKey = ['push', 'preferences'] as const;

export const usePushConfig = () =>
  useQuery({
    queryKey: ['push', 'config'],
    queryFn: () => get<PushConfig>('/push/config', PushConfigSchema),
    staleTime: 5 * 60_000,
  });

export const usePushDevices = () =>
  useQuery({
    queryKey: devicesKey,
    queryFn: () => get<PushDevices>('/push/subscriptions', PushDevicesSchema),
  });

export function useInvalidatePushDevices() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: devicesKey });
}

export function useRemovePushDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del(`/push/subscriptions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: devicesKey }),
  });
}

export const usePushPreferences = () =>
  useQuery({
    queryKey: prefsKey,
    queryFn: () => get<PushPreferences>('/push/preferences', PushPreferencesSchema),
  });

export function useSavePushPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (update: PushPreferencesUpdate) =>
      put<PushPreferences>('/push/preferences', update, PushPreferencesSchema),
    onSuccess: (data) => qc.setQueryData(prefsKey, data),
  });
}

export const useSendPushTest = () =>
  useMutation({ mutationFn: () => post<PushTestResult>('/push/test', {}, PushTestResultSchema) });
