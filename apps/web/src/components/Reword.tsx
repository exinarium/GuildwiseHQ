import { useOrgTerms } from '../lib/terms.ts';

/** Product copy in the words of the active organization's mode. Never wrap user or agent content in it. */
export function Reword({ children }: { children: string }) {
  const t = useOrgTerms();
  return <>{t.reword(children)}</>;
}
