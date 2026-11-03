import type {
  FormDefinition,
  FormDto,
  FormLogoDto,
  FormStatus,
  FormSummaryDto,
  FormVersionDto,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post, put, upload as uploadBody } from '../client.ts';

export function useForms(status: FormStatus) {
  return useQuery({
    queryKey: ['forms', 'list', status],
    queryFn: async () => (await get<{ forms: FormSummaryDto[] }>(`/forms?status=${status}`)).forms,
  });
}

export function useForm(id: string | undefined) {
  return useQuery({
    queryKey: ['forms', 'one', id],
    enabled: !!id,
    queryFn: () => get<FormDto>(`/forms/${id}`),
  });
}

export function useFormVersion(id: string | undefined, version: number | undefined) {
  return useQuery({
    queryKey: ['forms', 'one', id, 'version', version],
    enabled: !!id && !!version,
    queryFn: () => get<FormVersionDto>(`/forms/${id}/versions/${version}`),
  });
}

export function useCreateForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (definition: FormDefinition) => post<FormDto>('/forms', { definition }),
    onSuccess: (f) => {
      qc.setQueryData(['forms', 'one', f.id], f);
      void qc.invalidateQueries({ queryKey: ['forms', 'list'] });
    },
  });
}

export function useSaveForm(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { baseVersion: number; definition: FormDefinition }) =>
      put<{ form: FormDto; created: boolean }>(`/forms/${id}`, v),
    onSuccess: (r) => {
      qc.setQueryData(['forms', 'one', id], r.form);
      void qc.invalidateQueries({ queryKey: ['forms', 'list'] });
    },
  });
}

export function useArchiveForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; archive: boolean }) =>
      post<null>(`/forms/${v.id}/${v.archive ? 'archive' : 'unarchive'}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['forms'] }),
  });
}

/** Uploads the logo image as the raw body; the server reads the type from the bytes. */
export async function uploadFormLogo(file: File): Promise<FormLogoDto> {
  return uploadBody<FormLogoDto>('/forms/logos', file);
}

export interface StorageConnectionOption {
  id: string;
  name: string;
}

/** The firm's storage connections. A 404 (the connectors are not available yet) means none: only "Not set" is offered. */
export function useStorageConnections() {
  return useQuery({
    queryKey: ['org', 'storage', 'connections'],
    retry: false,
    queryFn: async (): Promise<StorageConnectionOption[]> => {
      try {
        const r = await get<{ connections: Array<{ id: string; name?: string; label?: string }> }>(
          '/org/storage/connections',
        );
        return (r.connections ?? []).map((c) => ({ id: c.id, name: c.name ?? c.label ?? c.id }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return [];
        throw e;
      }
    },
  });
}
