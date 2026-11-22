import { type SetupOffersWire, SetupOffersWireSchema } from '@aom/shared';
import { type Queryable, rows } from '../db/sql.ts';

/**
 * The names the installer's one screen shows (easy-runner-setup): for each organisation this workstation works for, its
 * name, the role the user has there, and the DevOps helper hired for this workstation; plus the repositories of those
 * organisations' active projects. Sent in the pair response and in every `welcome`. It only names things: the runner
 * grants nothing without a local yes, and every organisation defaults to No (rv6-6).
 *
 * Names that would not pass the wire schema (control characters) are left out rather than failing the pairing.
 */
export async function setupOffersFor(db: Queryable, workstationId: string): Promise<SetupOffersWire> {
  const orgs = await rows<{
    org_id: string;
    org_name: string;
    role: string | null;
    agent_id: string | null;
    agent_name: string | null;
  }>(
    db,
    `SELECT s.org_id, o.name AS org_name, m.role,
            a.id AS agent_id, a.name AS agent_name
       FROM workstation_org_serving s
       JOIN workstations w ON w.id = s.workstation_id
       JOIN organizations o ON o.id = s.org_id
       LEFT JOIN org_members m ON m.org_id = s.org_id AND m.user_id = w.user_id AND m.status = 'active'
       LEFT JOIN LATERAL (
         SELECT id, name FROM agents
          WHERE workstation_id = s.workstation_id AND org_id = s.org_id AND is_devops AND status = 'active'
          ORDER BY hired_at, id LIMIT 1
       ) a ON true
      WHERE s.workstation_id = $1 AND s.serving
      ORDER BY o.name, s.org_id
      LIMIT 500`,
    [workstationId],
  );
  const repos = await rows<{ url: string; name: string }>(
    db,
    `SELECT DISTINCT ON (r.remote_url_normalized) r.remote_url AS url, r.name
       FROM project_repos r
       JOIN projects p ON p.id = r.project_id AND p.status = 'active'
       JOIN workstation_org_serving s ON s.org_id = p.org_id AND s.workstation_id = $1 AND s.serving
      WHERE r.removed_at IS NULL
      ORDER BY r.remote_url_normalized, r.name
      LIMIT 500`,
    [workstationId],
  );
  const roleName = (r: string | null) =>
    r === 'owner' ? 'Owner' : r === 'admin' ? 'Admin' : r === 'member' ? 'Member' : 'Member';
  const wire = {
    orgs: orgs.map((o) => ({
      orgId: o.org_id,
      orgName: o.org_name,
      role: roleName(o.role),
      ...(o.agent_id ? { devopsAgentId: o.agent_id } : {}),
      ...(o.agent_id && o.agent_name ? { devopsAgentName: o.agent_name } : {}),
    })),
    repos: repos.map((r) => ({ url: r.url, name: r.name })),
  };
  // keep every entry that passes on its own; drop only the ones that do not
  const orgsOk = wire.orgs.filter((o) => SetupOffersWireSchema.safeParse({ orgs: [o], repos: [] }).success);
  const reposOk = wire.repos.filter((r) => SetupOffersWireSchema.safeParse({ orgs: [], repos: [r] }).success);
  return { orgs: orgsOk, repos: reposOk };
}
