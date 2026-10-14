import {
  type CreateMailInboxRequest,
  type InboundHealth,
  InboundHealthSchema,
  type MailInboxDto,
  MailInboxDtoSchema,
  type MailInboxesResponse,
  MailInboxesResponseSchema,
  type MailMessageDto,
  MailMessagesResponseSchema,
  type MailReplyRequest,
  type MailThreadDto,
  MailThreadDtoSchema,
  type PatchMailInboxRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post } from '../client.ts';

export const mailInboxesKey = ['mail-inboxes'] as const;

/** The organisation's e-mail inboxes (Owner and Admins). `enabled: false` skips the request for other roles. */
export function useMailInboxes(enabled = true) {
  return useQuery({
    queryKey: mailInboxesKey,
    queryFn: () => get<MailInboxesResponse>('/mail-inboxes', MailInboxesResponseSchema),
    enabled,
  });
}

/** Recent messages of one inbox with what became of each. */
export function useInboxMessages(inboxId: string | undefined) {
  return useQuery({
    queryKey: [...mailInboxesKey, inboxId, 'messages'],
    queryFn: async () =>
      (
        await get<{ messages: MailMessageDto[] }>(
          `/mail-inboxes/${inboxId}/messages`,
          MailMessagesResponseSchema,
        )
      ).messages,
    enabled: !!inboxId,
    refetchInterval: 15_000,
  });
}

function useInboxAction<V>(fn: (v: V) => Promise<MailInboxDto>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void qc.invalidateQueries({ queryKey: mailInboxesKey }),
  });
}

export const useCreateMailInbox = () =>
  useInboxAction((b: CreateMailInboxRequest) => post<MailInboxDto>('/mail-inboxes', b, MailInboxDtoSchema));
export const usePatchMailInbox = () =>
  useInboxAction((v: { id: string; body: PatchMailInboxRequest }) =>
    patch<MailInboxDto>(`/mail-inboxes/${v.id}`, v.body, MailInboxDtoSchema),
  );
export const useRotateMailInbox = () =>
  useInboxAction((id: string) => post<MailInboxDto>(`/mail-inboxes/${id}/rotate`, {}, MailInboxDtoSchema));

/** Super admin: the inbound mail provider's health (Platform > Inbound mail). */
export function useInboundHealth() {
  return useQuery({
    queryKey: ['platform', 'inbound'],
    queryFn: () => get<InboundHealth>('/platform/inbound', InboundHealthSchema),
    refetchInterval: 30_000,
  });
}

/** A conversation, found through its card or its id (`kind`). */
export type ThreadRef = { kind: 'card'; id: string } | { kind: 'thread'; id: string };
const threadPath = (r: ThreadRef) =>
  r.kind === 'card' ? `/cards/${r.id}/mail-thread` : `/mail-threads/${r.id}`;
const replyPath = (r: ThreadRef) =>
  r.kind === 'card' ? `/cards/${r.id}/mail-reply` : `/mail-threads/${r.id}/reply`;

export function useMailThread(ref: ThreadRef | undefined) {
  return useQuery({
    queryKey: ['mail-thread', ref?.kind, ref?.id],
    queryFn: () => get<MailThreadDto>(threadPath(ref as ThreadRef), MailThreadDtoSchema),
    enabled: !!ref,
    retry: false,
  });
}

/** Sends a reply as the organisation; refreshes the conversation and the card's thread. */
export function useMailReply(ref: ThreadRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: MailReplyRequest) => post<MailThreadDto>(replyPath(ref), b, MailThreadDtoSchema),
    onSuccess: (thread) => {
      qc.setQueryData(['mail-thread', ref.kind, ref.id], thread);
      for (const key of ['card', 'thread']) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}
