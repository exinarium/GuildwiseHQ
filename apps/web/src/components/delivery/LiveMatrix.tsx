import { Link } from 'react-router';
import { type LiveHealth, type LiveRow, useOrgLive } from '../../api/queries/releases.ts';
import { ageLabel } from '../../lib/time.ts';
import { Badge, ErrorBox, ListSkeleton, Panel } from '../ui.tsx';

const HEALTH: Record<LiveHealth, { text: string; tone: 'green' | 'red' | 'amber' | 'neutral' }> = {
  healthy: { text: 'Healthy', tone: 'green' },
  unhealthy: { text: 'Not healthy', tone: 'red' },
  updating: { text: 'Updating', tone: 'amber' },
  unknown: { text: 'Not known yet', tone: 'neutral' },
};

const since = (iso: string | null) => {
  if (!iso) return 'never released';
  const a = ageLabel(iso);
  return a === 'now' ? 'just now' : `${a} ago`;
};

/**
 * What is live (docs/design/environments-ux.md journey J): one row per project and site with the version, since when, its
 * health and where it runs. A table from md up, cards on a phone. Read-only: everyone in the organization may look.
 */
export function LiveMatrix({ canRelease = false }: { canRelease?: boolean }) {
  const q = useOrgLive();
  const rows = q.data ?? [];
  if (q.isPending) return <ListSkeleton label="Loading what is live" />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (rows.length === 0)
    return (
      <Panel data-testid="live-empty">
        <p className="text-sm text-subtle">
          Nothing is live yet. A site shows up here after its first release.
        </p>
      </Panel>
    );
  const waiting = (r: LiveRow, id: string) =>
    r.waitingRelease > 0 ? (
      canRelease ? (
        <Link
          to="/releases?tab=waiting"
          className="text-sm text-brand-text underline-offset-2 hover:underline"
          data-testid={`${id}-${r.projectKey}-${r.env}`}
        >
          {r.waitingRelease} {r.waitingRelease === 1 ? 'release' : 'releases'} waiting
        </Link>
      ) : (
        <span className="text-sm text-muted" data-testid={`${id}-${r.projectKey}-${r.env}`}>
          {r.waitingRelease} {r.waitingRelease === 1 ? 'release' : 'releases'} waiting
        </span>
      )
    ) : null;
  return (
    <div data-testid="live-matrix">
      <ul className="flex flex-col gap-3 md:hidden" data-testid="live-cards">
        {rows.map((r) => (
          <li
            key={`${r.projectId}|${r.env}`}
            className="flex flex-col gap-1.5 rounded-control border border-line bg-surface p-3"
            data-testid={`live-card-${r.projectKey}-${r.env}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/p/${r.projectKey}/environments`} className="font-semibold text-fg hover:underline">
                {r.projectKey}
              </Link>
              <span className="text-sm text-fg">{r.label}</span>
              <Badge tone={HEALTH[r.health].tone}>{HEALTH[r.health].text}</Badge>
              {r.releasesPaused && (
                <Badge tone="amber" data-testid={`live-paused-${r.projectKey}-${r.env}`}>
                  Releases paused
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted">
              Version <span className="font-mono text-fg">{r.version ?? 'none yet'}</span>, {since(r.since)}
              {r.placeName ? `, on ${r.placeName}` : ''}
            </p>
            {waiting(r, 'live-card-waiting')}
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-control border border-line bg-surface md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs text-subtle">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Project
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Site
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Version
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Since
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Health
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Place
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                <span className="sr-only">Waiting</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={`${r.projectId}|${r.env}`} data-testid={`live-row-${r.projectKey}-${r.env}`}>
                <td className="px-3 py-2 font-medium text-fg">
                  <Link to={`/p/${r.projectKey}/environments`} className="hover:underline">
                    {r.projectKey}
                  </Link>
                </td>
                <td className="px-3 py-2">{r.label}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.version ?? 'none yet'}</td>
                <td className="px-3 py-2 text-muted">{since(r.since)}</td>
                <td className="px-3 py-2">
                  <Badge tone={HEALTH[r.health].tone}>{HEALTH[r.health].text}</Badge>
                  {r.releasesPaused && (
                    <Badge tone="amber" data-testid={`live-paused-row-${r.projectKey}-${r.env}`}>
                      Releases paused
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-muted">{r.placeName ?? ''}</td>
                <td className="px-3 py-2">{waiting(r, 'live-waiting')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
