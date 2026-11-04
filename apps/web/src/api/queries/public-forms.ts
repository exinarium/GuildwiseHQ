import type {
  ClientLinkDto,
  CreateClientLink,
  FormPublicationDto,
  FormSubmissionDto,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';

export function usePublication(formId: string | undefined) {
  return useQuery({
    queryKey: ['forms', 'one', formId, 'publication'],
    enabled: !!formId,
    queryFn: () => get<FormPublicationDto>(`/forms/${formId}/publication`),
  });
}

/** Publish / unpublish / reset the public link: one mutation, the answer is the new publication. */
export function usePublicationAction(formId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'publish' | 'unpublish' | 'reset') =>
      post<FormPublicationDto>(
        action === 'reset' ? `/forms/${formId}/publication/reset-link` : `/forms/${formId}/${action}`,
      ),
    onSuccess: (p) => {
      qc.setQueryData(['forms', 'one', formId, 'publication'], p);
      void qc.invalidateQueries({ queryKey: ['forms', 'one', formId, 'links'] });
    },
  });
}

export function useClientLinks(formId: string | undefined) {
  return useQuery({
    queryKey: ['forms', 'one', formId, 'links'],
    enabled: !!formId,
    queryFn: async () => (await get<{ links: ClientLinkDto[] }>(`/forms/${formId}/client-links`)).links,
  });
}

export function useCreateClientLink(formId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: Partial<CreateClientLink> & { reference: string }) =>
      post<ClientLinkDto>(`/forms/${formId}/client-links`, v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['forms', 'one', formId, 'links'] }),
  });
}

export function useRevokeClientLink(formId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => post<null>(`/forms/${formId}/client-links/${linkId}/revoke`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['forms', 'one', formId, 'links'] }),
  });
}

export function useFormSubmissions(formId: string | undefined) {
  return useQuery({
    queryKey: ['forms', 'one', formId, 'submissions'],
    enabled: !!formId,
    queryFn: async () =>
      (await get<{ submissions: FormSubmissionDto[] }>(`/forms/${formId}/submissions`)).submissions,
  });
}
