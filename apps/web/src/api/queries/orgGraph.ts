import { type CreateOrgGraphLinkRequest, OrgGraphLinksResponseSchema } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from '../client.ts';

/** Links the Owner asserted between projects: project ids, or names they typed. Derived links are not served. */
export const orgGraphLinksKey = ['org-graph-links'] as const;

export function useOrgGraphLinks() {
  return useQuery({
    queryKey: orgGraphLinksKey,
    queryFn: async () => (await get('/org-graph/links', OrgGraphLinksResponseSchema)).links,
  });
}

export function useAssertOrgGraphLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: CreateOrgGraphLinkRequest) => post('/org-graph/links', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgGraphLinksKey }),
  });
}

export function useRetractOrgGraphLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del(`/org-graph/links/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgGraphLinksKey }),
  });
}
