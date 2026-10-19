import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/**
 * Project graph status (docs/design/project-graphs.md section 1): the row says which commit of a repository is indexed
 * and how big the graph is. It holds nothing derived from code and is never used to rebuild a graph (the indexer re-runs
 * at the recorded commit on the workstation). Deterministic: only the event and `e.createdAt`.
 */
export const graphProjectors: Record<string, Projector> = {
  ProjectGraphRequested: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectGraphRequested'>).payload;
    await exec(
      tx,
      `INSERT INTO project_graphs (project_id, repo_id, repo_key, org_id, status, requested_at, updated_at)
       VALUES ($1,$2,$3,$4,'requested',$5,$5)
       ON CONFLICT (project_id, repo_id) DO UPDATE
         SET repo_key = EXCLUDED.repo_key, requested_at = EXCLUDED.requested_at, updated_at = EXCLUDED.updated_at,
             status = CASE WHEN project_graphs.status = 'indexed' THEN 'indexed' ELSE 'requested' END`,
      [p.projectId, p.repoId, p.repoKey, p.orgId, e.createdAt],
    );
  },
  ProjectGraphIndexed: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectGraphIndexed'>).payload;
    await exec(
      tx,
      `INSERT INTO project_graphs (project_id, repo_id, repo_key, org_id, status, commit_id, files, nodes, edges, modules,
                                   indexer_version, duration_ms, workstation_id, vault_id, indexed_at, updated_at)
       VALUES ($1,$2,$3,$4,'indexed',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       ON CONFLICT (project_id, repo_id) DO UPDATE
         SET repo_key = EXCLUDED.repo_key, status = 'indexed', commit_id = EXCLUDED.commit_id, files = EXCLUDED.files,
             nodes = EXCLUDED.nodes, edges = EXCLUDED.edges, modules = EXCLUDED.modules,
             indexer_version = EXCLUDED.indexer_version, duration_ms = EXCLUDED.duration_ms,
             workstation_id = EXCLUDED.workstation_id, vault_id = EXCLUDED.vault_id, fail_reason = NULL,
             indexed_at = EXCLUDED.indexed_at, updated_at = EXCLUDED.updated_at`,
      [
        p.projectId,
        p.repoId,
        p.repoKey,
        p.orgId,
        p.commit,
        p.files,
        p.nodes,
        p.edges,
        p.modules,
        p.indexerVersion,
        p.durationMs,
        p.workstationId,
        p.vaultId,
        e.createdAt,
      ],
    );
  },
  ProjectGraphUpdated: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectGraphUpdated'>).payload;
    await exec(
      tx,
      `INSERT INTO project_graphs (project_id, repo_id, repo_key, org_id, status, commit_id, files, nodes, edges, modules,
                                   indexer_version, duration_ms, workstation_id, vault_id, indexed_at, updated_at)
       VALUES ($1,$2,$3,$4,'indexed',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       ON CONFLICT (project_id, repo_id) DO UPDATE
         SET repo_key = EXCLUDED.repo_key, status = 'indexed', commit_id = EXCLUDED.commit_id,
             files = EXCLUDED.files,
             nodes = EXCLUDED.nodes, edges = EXCLUDED.edges, modules = EXCLUDED.modules,
             indexer_version = EXCLUDED.indexer_version, duration_ms = EXCLUDED.duration_ms,
             workstation_id = EXCLUDED.workstation_id, vault_id = EXCLUDED.vault_id, fail_reason = NULL,
             indexed_at = EXCLUDED.indexed_at, updated_at = EXCLUDED.updated_at`,
      [
        p.projectId,
        p.repoId,
        p.repoKey,
        p.orgId,
        p.toCommit,
        p.files,
        p.nodes,
        p.edges,
        p.modules,
        p.indexerVersion,
        p.durationMs,
        p.workstationId,
        p.vaultId,
        e.createdAt,
      ],
    );
  },
  ProjectGraphFailed: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectGraphFailed'>).payload;
    await exec(
      tx,
      `INSERT INTO project_graphs (project_id, repo_id, repo_key, org_id, status, fail_reason, workstation_id, updated_at)
       VALUES ($1,$2,$3,$4,'failed',$5,$6,$7)
       ON CONFLICT (project_id, repo_id) DO UPDATE
         SET repo_key = EXCLUDED.repo_key, fail_reason = EXCLUDED.fail_reason, updated_at = EXCLUDED.updated_at,
             workstation_id = COALESCE(EXCLUDED.workstation_id, project_graphs.workstation_id),
             status = CASE WHEN project_graphs.status = 'indexed' THEN 'indexed' ELSE 'failed' END`,
      [p.projectId, p.repoId, p.repoKey, p.orgId, p.reason, p.workstationId ?? null, e.createdAt],
    );
  },
  // Numbers per measured card shift (docs/design/project-graphs.md section 11); a shift without a graph is not stored.
  ShiftContextMeasured: async (tx, e) => {
    const p = (e.event as EventOf<'ShiftContextMeasured'>).payload;
    if (p.graphArm === 'none') return;
    await exec(
      tx,
      `INSERT INTO shift_context_metrics (shift_id, org_id, project_id, card_id, graph_arm, billed_input_tokens,
                                          output_tokens, discovery_bytes, discovery_calls, graph_bytes, graph_calls,
                                          brief_bytes, measured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (shift_id) DO NOTHING`,
      [
        p.shiftId,
        p.orgId,
        p.projectId,
        p.cardId,
        p.graphArm,
        p.billedInputTokens,
        p.outputTokens,
        p.discoveryBytes,
        p.discoveryCalls,
        p.graphBytes,
        p.graphCalls,
        p.briefBytes,
        e.createdAt,
      ],
    );
  },
};
