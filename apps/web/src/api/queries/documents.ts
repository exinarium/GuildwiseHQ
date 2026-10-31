import type {
  ChangeDocumentStatusRequest,
  DocumentDto,
  DocumentKind,
  DocumentStatus,
  DocumentTagCountDto,
  DocumentVersionDto,
  DocumentWithContentDto,
  SaveDocumentVersionRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put, qs, upload } from '../client.ts';

export function useDocuments(
  filter: {
    kind?: DocumentKind;
    status?: DocumentStatus;
    threadId?: string;
    /** Text search over title, file name and current text. */
    q?: string;
    /** Documents that carry all of these tags. */
    tags?: string[];
  } = {},
) {
  const { tags, ...rest } = filter;
  const query = { ...rest, ...(tags?.length ? { tags: tags.join(',') } : {}) };
  return useQuery({
    queryKey: ['documents', 'list', filter],
    queryFn: async () => (await get<{ documents: DocumentDto[] }>(`/documents${qs(query)}`)).documents,
  });
}

/** The tags in use in the documents this user may see, most used first. */
export function useDocumentTags() {
  return useQuery({
    queryKey: ['documents', 'tags'],
    queryFn: async () => (await get<{ tags?: DocumentTagCountDto[] }>('/documents/tags')).tags ?? [],
  });
}

export function useSetDocumentTags(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tags: string[]) =>
      (await put<{ document: DocumentWithContentDto }>(`/documents/${id}/tags`, { tags })).document,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents'] }),
  });
}

export interface UploadDocumentInput {
  file: File;
  title?: string;
  projectId?: string;
  kind?: DocumentKind;
  tags?: string[];
}

export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (i: UploadDocumentInput) =>
      (
        await upload<{ document: DocumentWithContentDto }>(
          `/documents/upload${qs({
            title: i.title,
            projectId: i.projectId,
            kind: i.kind,
            tags: i.tags?.length ? i.tags.join(',') : undefined,
          })}`,
          i.file,
        )
      ).document,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents'] }),
  });
}

/** Where an uploaded document's original file is served (an `<img>` source or a download link). */
export const documentFileUrl = (id: string, download = false): string =>
  `/api/documents/${encodeURIComponent(id)}/file${download ? '?download=1' : ''}`;

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
