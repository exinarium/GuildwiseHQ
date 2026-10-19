import type { ProjectGraphRepoStatus } from '@aom/shared';
import { useProjectGraph, useReindexProjectGraph } from '../api/queries/graph.ts';
import { formatDateTime } from '../lib/time.ts';
import { Badge, Button, ErrorBox, Panel } from './ui.tsx';

const STATUS_LABEL: Record<ProjectGraphRepoStatus['status'], string> = {
  none: 'not indexed yet',
  requested: 'indexing',
  indexed: 'indexed',
  failed: 'could not index',
};

const FAIL_TEXT: Record<string, string> = {
  no_clone: 'No workstation of the project vault holds a clone of this repository.',
  no_vault: 'The project vault is not available on the workstation that holds the clone.',
  vault_unavailable: 'The project vault could not be reached on the workstation.',
  no_commit: 'The working branch has no commit yet.',
  usage_limit: 'The model usage limit was reached; it will be tried again.',
  error: 'The indexer stopped with an error on the workstation (see its log).',
};

/**
 * "A brain for your project": the status of the code graph the agents use. The graph is built on your workstation and kept in
 * the project vault; nothing derived from your code is shown here or sent to Guildwise HQ, only counts and the indexed commit.
 */
export function GraphStatusPanel({ projectId, canChange }: { projectId: string; canChange: boolean }) {
  const q = useProjectGraph(projectId);
  const reindex = useReindexProjectGraph(projectId);
  // Switched off on this server (or an old server): the panel is not there.
  if (!q.data?.enabled) return null;
  const { vault, repos } = q.data;
  return (
    <Panel>
      <h2 className="mb-1 text-lg font-semibold text-fg">Code map for agents</h2>
      <p className="mb-3 text-sm text-muted">
        Your agents find their way in the code with a map that is built on your own workstation and kept in
        the project vault
        {vault?.storage === 'local' ? ' (a folder on your workstation: back it up yourself)' : ''}. Nothing
        from your code is sent to Guildwise HQ; this page only shows how big the map is and which commit it is
        based on.
      </p>
      {repos.length === 0 && <p className="text-sm text-subtle">Add a repository to build a map.</p>}
      <ul className="flex flex-col divide-y divide-line text-sm" data-testid="graph-repos">
        {repos.map((r) => (
          <li key={r.repoId} className="flex flex-col gap-1 py-2" data-testid={`graph-repo-${r.repoName}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-fg">{r.repoName}</span>
              <Badge tone={r.status === 'indexed' ? 'green' : r.status === 'failed' ? 'amber' : 'neutral'}>
                {STATUS_LABEL[r.status]}
              </Badge>
              {r.status === 'indexed' && (
                <span className="text-xs text-subtle">
                  {r.nodes.toLocaleString()} nodes, {r.edges.toLocaleString()} links, {r.modules} modules, at
                  commit <span className="font-mono">{r.commit?.slice(0, 8)}</span>
                  {r.indexedAt ? `, ${formatDateTime(r.indexedAt)}` : ''}
                </span>
              )}
            </div>
            {r.failReason && (
              <span className="text-xs text-warning">{FAIL_TEXT[r.failReason] ?? FAIL_TEXT.error}</span>
            )}
          </li>
        ))}
      </ul>
      {canChange && repos.length > 0 && (
        <div className="mt-3">
          <Button size="sm" loading={reindex.isPending} onClick={() => reindex.mutate()}>
            Index again
          </Button>
        </div>
      )}
      <ErrorBox error={reindex.error} />
    </Panel>
  );
}
