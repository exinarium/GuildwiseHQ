import type { CardAttachmentDto } from '@aom/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { del, upload } from '../client.ts';

/** Where a card's attachment is served (an `<img>` source or a download link). */
export const attachmentUrl = (cardId: string, id: string, download = false): string =>
  `/api/cards/${encodeURIComponent(cardId)}/attachments/${id}${download ? '?download=1' : ''}`;

export const uploadAttachment = (cardId: string, file: File) =>
  upload<CardAttachmentDto>(`/cards/${encodeURIComponent(cardId)}/attachments`, file);

export type UploadFailure = { name: string; message: string };

/** Uploads files one after the other; a failure is reported by file name and does not stop the others. */
export async function uploadAll(cardId: string, files: File[]): Promise<{ failed: UploadFailure[] }> {
  const failed: UploadFailure[] = [];
  for (const f of files) {
    try {
      await uploadAttachment(cardId, f);
    } catch (e) {
      failed.push({ name: f.name, message: e instanceof Error ? e.message : 'upload failed' });
    }
  }
  return { failed };
}

export function useRemoveAttachment(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del(`/cards/${encodeURIComponent(cardId)}/attachments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['card'] }),
  });
}

export function useUploadAttachments(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (files: File[]) => uploadAll(cardId, files),
    onSettled: () => qc.invalidateQueries({ queryKey: ['card'] }),
  });
}
