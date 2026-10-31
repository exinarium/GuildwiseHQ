import { type OrgMode, orgTerms, rewordForOrg } from '@aom/shared';
import { useMemo } from 'react';
import { useBusinessMode } from './orgMode.ts';

/** The words for the active organization's mode: short labels as keys, sentences through `reword`. */
export function useOrgTerms() {
  const business = useBusinessMode();
  return useMemo(() => {
    const mode: OrgMode = business ? 'business' : 'dev';
    return { ...orgTerms(mode), mode, reword: (s: string) => rewordForOrg(s, mode) };
  }, [business]);
}
export type OrgTermsApi = ReturnType<typeof useOrgTerms>;
