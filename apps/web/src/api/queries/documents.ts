import type {
  ChangeDocumentStatusRequest,
  DocumentDto,
  DocumentKind,
  DocumentStatus,
  DocumentVersionDto,
  DocumentWithContentDto,
  SaveDocumentVersionRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, qs } from '../client.ts';

export function useDocuments(
  filter: { kind?: DocumentKind; status?: DocumentStatus; threadId?: string } = {},
) {
  return useQuery({
    queryKey: ['documents', 'list', filter],
    queryFn: async () =>
      (await get<{ documents: DocumentDto[] }>(`/documents${qs({ ...filter })}`)).documents,
  });
}

export function useDocument(id: string | undefined) {
  return useQuery({
    queryKey: ['documents', id],
    enabled: !!id,
    queryFn: async () => (await get<{ document: DocumentWithContentDto }>(`/documents/${id}`)).document,
  });
}

/** One saved version with its text (the current one is already on the document). */
export function useDocumentVersion(id: string | undefined, version: number | null) {
  return useQuery({
    queryKey: ['documents', id, 'version', version],
    enabled: !!id && version !== null,
    queryFn: async () =>
      (await get<{ version: DocumentVersionDto }>(`/documents/${id}/versions/${version}`)).version,
  });
}

export function useChangeDocumentStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: ChangeDocumentStatusRequest) =>
      (await post<{ document: DocumentWithContentDto }>(`/documents/${id}/status`, b)).document,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discovery'] });
      return qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

export function useSaveDocumentVersion(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: SaveDocumentVersionRequest) =>
      (await post<{ document: DocumentWithContentDto }>(`/documents/${id}/versions`, b)).document,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents'] }),
  });
}
