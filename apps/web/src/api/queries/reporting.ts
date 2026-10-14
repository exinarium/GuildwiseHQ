import {
  type BriefingPreference,
  BriefingPreferenceSchema,
  type MeResponse,
  MeResponseSchema,
  type ReportingResponse,
  ReportingResponseSchema,
  type UpdateReportingRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../client.ts';
import { meKey } from './auth.ts';

export const reportingKey = ['reporting'] as const;

/** The organization's BA reporting preferences plus the manager's time zone. */
export function useReporting() {
  return useQuery({
    queryKey: reportingKey,
    queryFn: () => get<ReportingResponse>('/reporting', ReportingResponseSchema),
  });
}

export function useUpdateReporting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: UpdateReportingRequest) =>
      put<ReportingResponse>('/reporting', b, ReportingResponseSchema),
    onSuccess: (r) => {
      qc.setQueryData(reportingKey, r);
      // the quiet cap shows on the Interests page
      void qc.invalidateQueries({ queryKey: ['interests'] });
    },
  });
}

/** Your own expert mode for version control (off by default). */
export function useSetExpertMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => put<MeResponse>('/auth/git-expert', { enabled }, MeResponseSchema),
    onSuccess: (me) => qc.setQueryData(meKey, me),
  });
}

export function useSetTimezone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (timezone: string) => put<MeResponse>('/auth/timezone', { timezone }, MeResponseSchema),
    onSuccess: (me) => {
      qc.setQueryData(meKey, me);
      void qc.invalidateQueries({ queryKey: reportingKey });
    },
  });
}

/** Your own switch for the Monday briefing mail (on unless you turned it off). */
export function useBriefingPreference() {
  return useQuery({
    queryKey: ['me', 'weekly-briefing'],
    queryFn: () => get<BriefingPreference>('/me/weekly-briefing', BriefingPreferenceSchema),
  });
}

export function useSetBriefingPreference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      put<BriefingPreference>('/me/weekly-briefing', { enabled }, BriefingPreferenceSchema),
    onSuccess: (data) => qc.setQueryData(['me', 'weekly-briefing'], data),
  });
}
