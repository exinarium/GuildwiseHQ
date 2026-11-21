import type { DevopsCommandLogEntry } from '@aom/shared';
import { formatDateTime } from '../lib/time.ts';
import { Badge, EmptyState, ErrorBox, ListSkeleton, Panel } from './ui.tsx';

/**
 * Every shell command a DevOps session ran (or the runner's guard refused), as the guard saw it (R17-4). Shown to the
 * organization's Owner and the workstation's owner only; the platform sees counts.
 */
export function DevopsCommandLog({
  title,
  intro,
  query,
  showWorkstation = true,
}: {
  title: string;
  intro: string;
  query: {
    data?: DevopsCommandLogEntry[] | undefined;
    isPending: boolean;
    error: unknown;
    refetch: () => unknown;
  };
  showWorkstation?: boolean;
}) {
  return (
    <Panel title={title}>
      <p className="mb-3 text-sm text-muted">{intro}</p>
      {query.isPending && <ListSkeleton label="Loading commands" rows={3} />}
      {query.error ? <ErrorBox error={query.error} onRetry={() => query.refetch()} /> : null}
      {query.data && query.data.length === 0 && (
        <EmptyState
          bare
          title="No DevOps commands yet"
          description="Commands appear here once a DevOps session runs."
        />
      )}
      {query.data && query.data.length > 0 && (
        <ul className="divide-y divide-line text-sm" data-testid="devops-command-log">
          {query.data.map((e) => (
            <li key={e.id} className="flex flex-col gap-1 py-2">
              <span className="flex flex-wrap items-center gap-2 text-xs text-subtle">
                <span>{formatDateTime(e.at)}</span>
                {showWorkstation && e.workstationName && <span>{e.workstationName}</span>}
                <span>{e.kind === 'chat' ? 'chat' : (e.shiftKind ?? 'shift')}</span>
                <Badge tone={e.decision === 'refused' ? 'danger' : 'success'}>{e.decision}</Badge>
                {e.rule && <span>rule {e.rule}</span>}
              </span>
              <code className="break-all font-mono text-xs text-fg">{e.command}</code>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
