import {
  type UpdateValueSettingsRequest,
  type ValueQuery,
  type ValueReport,
  ValueReportSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put, qs } from '../client.ts';

/** The value report of a month (default the current one), for Owner and Admin. */
export function useValueReport(q: ValueQuery = {}) {
  return useQuery({
    queryKey: ['value', q.month ?? '', q.projectId ?? ''],
    queryFn: () => get(`/value${qs({ ...q })}`, ValueReportSchema) as Promise<ValueReport>,
  });
}

export const valueCsvUrl = (q: ValueQuery = {}): string => `/api/value/export.csv${qs({ ...q })}`;

export function useUpdateValueSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: UpdateValueSettingsRequest) => put('/value/settings', v, ValueReportSchema),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['value'] }),
  });
}
