import { Badge } from '../ui.tsx';
import { useOrgTerms } from '../../lib/terms.ts';

export const SOURCE_LABEL = {
  builtin: 'built-in',
  'org-vault': 'organization vault',
  'project-repo': 'project repository',
  pack: 'pack',
} as const;
type Source = keyof typeof SOURCE_LABEL;

const SOURCE_TONE = {
  builtin: 'neutral',
  'org-vault': 'blue',
  'project-repo': 'violet',
  pack: 'amber',
} as const;

/** Where a registry entry comes from; a pack's name is added (`pack: acme`). */
export function SourceBadge({ source, pack }: { source: Source; pack?: string | undefined }) {
  const t = useOrgTerms();
  return (
    <Badge tone={SOURCE_TONE[source]} data-testid={`source-${source}`}>
      {t.reword(SOURCE_LABEL[source])}
      {source === 'pack' && pack ? `: ${pack}` : ''}
    </Badge>
  );
}

export const UNUSABLE_LABEL = {
  untrusted: 'needs approval',
  pending: 'needs approval',
  integrity: 'files changed',
  unreviewed: 'needs review',
  changed: 'changed, needs review',
} as const;

/** Why a pack capability cannot be used yet (nothing when it can). */
export function UnusableBadge({
  usable,
  reason,
}: {
  usable: boolean;
  reason?: 'untrusted' | 'integrity' | 'pending' | 'unreviewed' | 'changed' | undefined;
}) {
  if (usable) return null;
  const r = reason ?? 'untrusted';
  return (
    <Badge tone={r === 'integrity' ? 'red' : 'amber'} data-testid="unusable">
      {UNUSABLE_LABEL[r]}
    </Badge>
  );
}

export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '');
