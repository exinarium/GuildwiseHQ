import { isBusinessOrg, type MeResponse, type OrgMode, orgTerms, rewordForOrg } from '@aom/shared';
import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useMemo, useSyncExternalStore } from 'react';
import { meKey } from '../api/queries/auth.ts';

const NONE = () => () => undefined;

/**
 * The words for the active organization's mode: short labels as keys, sentences through `reword`.
 * It only reads `me` from the query cache (the shell loads it, so it starts no request and needs no provider);
 * before `me` is there, the developer words show.
 */
export function useOrgTerms() {
  const client = useContext(QueryClientContext);
  const me = useSyncExternalStore(client ? (cb) => client.getQueryCache().subscribe(cb) : NONE, () =>
    client?.getQueryData<MeResponse | null>(meKey),
  );
  const business = isBusinessOrg(me?.activeOrg);
  return useMemo(() => {
    const mode: OrgMode = business ? 'business' : 'dev';
    return { ...orgTerms(mode), mode, reword: (s: string) => rewordForOrg(s, mode) };
  }, [business]);
}
export type OrgTermsApi = ReturnType<typeof useOrgTerms>;
