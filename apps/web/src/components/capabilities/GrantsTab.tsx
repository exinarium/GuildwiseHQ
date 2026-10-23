import { Link } from 'react-router';
import { useCapabilities } from '../../api/queries/capabilities.ts';
import { useOrgCatalogue } from '../../api/queries/org.ts';
import { Badge, EmptyState, ErrorBox, ListSkeleton } from '../ui.tsx';
import { SourceBadge, UnusableBadge } from './badges.tsx';

/** Which skills each role is given, resolved against the registry. A role is edited on Roles & workflows. */
export function GrantsTab() {
  const cat = useOrgCatalogue();
  const reg = useCapabilities({ kind: 'skill' });
  const skills = new Map((reg.data?.items ?? []).filter((i) => i.kind === 'skill').map((i) => [i.key, i]));
  const roles = (cat.data?.roles ?? []).map((r) => {
    const def = (r.versions.find((v) => v.status === 'active') ?? r.versions[0])?.definition;
    const granted = [...new Set([...(def?.skills ?? []), ...(r.extensions?.skills ?? [])])];
    return { key: r.key, name: def?.name ?? r.key, granted };
  });
  return (
    <div className="flex flex-col gap-3" data-testid="grants-tab">
      <p className="text-sm text-muted">
        A role's skills are the registry skills its agents may use. Pick them for a role on{' '}
        <Link className="text-brand-text underline" to="/org">
          Roles &amp; workflows
        </Link>
        . Only skills that can be used now are offered there; a pack skill that stops being approved drops out
        of use and is marked here.
      </p>
      {(cat.isPending || reg.isPending) && <ListSkeleton label="Loading roles" rows={3} />}
      {cat.isError && <ErrorBox error={cat.error} onRetry={() => cat.refetch()} />}
      <ul className="flex flex-col gap-2" data-testid="grants">
        {roles.map((r) => (
          <li
            key={r.key}
            className="rounded-card border border-line bg-surface p-3"
            data-testid={`grant-${r.key}`}
          >
            <p className="font-medium text-fg">
              {r.name} <code className="text-xs text-muted">{r.key}</code>
            </p>
            {r.granted.length === 0 ? (
              <p className="text-sm text-subtle">No skills.</p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-2">
                {r.granted.map((k) => {
                  const hit = skills.get(k);
                  return (
                    <li key={k} className="flex items-center gap-1">
                      <Badge tone="blue">{k}</Badge>
                      {hit ? (
                        <>
                          <SourceBadge source={hit.source} pack={hit.pack} />
                          <UnusableBadge usable={hit.usable} reason={hit.unusableReason} />
                        </>
                      ) : (
                        <Badge title="Not a registry skill: kept as plain text.">not in the registry</Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {cat.data && roles.length === 0 && <EmptyState title="No roles" />}
    </div>
  );
}
