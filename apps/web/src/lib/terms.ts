import { effectiveView, type MeResponse, type OrgMode, orgTerms, rewordForOrg } from '@aom/shared';
import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useMemo, useSyncExternalStore } from 'react';
import { meKey } from '../api/queries/auth.ts';

const NONE = () => () => undefined;

/**
 * The words for the member's effective VIEW (their own choice, else the organization default): short labels as keys,
 * sentences through `reword`. It only reads `me` from the query cache (the shell loads it, so it starts no request and
 * needs no provider); before `me` is there, the software words show.
 */
export function useOrgTerms() {
  const client = useContext(QueryClientContext);
  const me = useSyncExternalStore(client ? (cb) => client.getQueryCache().subscribe(cb) : NONE, () =>
    client?.getQueryData<MeResponse | null>(meKey),
  );
  const view: OrgMode = effectiveView(me?.activeOrg);
  return useMemo(
    () => ({ ...orgTerms(view), mode: view, reword: (s: string) => rewordForOrg(s, view) }),
    [view],
  );
}
export type OrgTermsApi = ReturnType<typeof useOrgTerms>;
