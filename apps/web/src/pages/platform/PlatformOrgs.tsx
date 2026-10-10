import type { OrgStatus } from '@aom/shared';
import { Building2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { usePlatformOrgs } from '../../api/queries/platform.ts';
import {
  Badge,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  Select,
  TextInput,
} from '../../components/ui.tsx';
import { formatDateTime } from '../../lib/time.ts';

export const STATUS_TONE: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  trial: 'info',
  suspended: 'warning',
  expired: 'warning',
  cancelled: 'danger',
};

/** `/platform`: every organization, with its Owner, size and status (metadata only; never its work). */
export function PlatformOrgs() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | OrgStatus>('');
  const [sort, setSort] = useState('name');
  const orgs = usePlatformOrgs({ q: q || undefined, status: status || undefined, sort } as never);
  return (
    <div>
      <PageHeader
        title="Organizations"
        sub="Every organization on this platform. You see metadata, never their work."
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_10rem_10rem]">
        <TextInput
          label="Search"
          placeholder="Name or Owner email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as '' | OrgStatus)}>
          <option value="">All</option>
          {['active', 'trial', 'suspended', 'cancelled'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select label="Sort by" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="name">Name</option>
          <option value="created">Created</option>
          <option value="active">Last active</option>
          <option value="members">Members</option>
        </Select>
      </div>
      {orgs.isPending && <ListSkeleton label="Loading organizations" rows={4} />}
      {orgs.isError && <ErrorBox error={orgs.error} onRetry={() => orgs.refetch()} />}
      {orgs.data?.length === 0 && (
        <EmptyState
          icon={Building2}
          title="No organizations match"
          description="Invite a new organization from the Invitations tab."
        />
      )}
      {orgs.data && orgs.data.length > 0 && (
        <Panel padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="platform-orgs">
              <thead className="text-left text-xs text-subtle">
                <tr>
                  <th className="px-4 py-2 font-medium">Organization</th>
                  <th className="px-4 py-2 font-medium">Owner</th>
                  <th className="px-4 py-2 font-medium">Members</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Plan</th>
                  <th className="px-4 py-2 font-medium">Last active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {orgs.data.map((o) => (
                  <tr key={o.id} data-testid={`platform-org-${o.name}`}>
                    <td className="px-4 py-2.5">
                      <Link to={`/platform/orgs/${o.id}`} className="font-medium text-brand hover:underline">
                        {o.name}
                      </Link>
                      {o.simulation && (
                        <Badge tone="amber" data-testid="simulation-badge">
                          Simulation
                        </Badge>
                      )}
                      {o.requireTwoFactor && <span className="ml-2 text-xs text-subtle">2FA required</span>}
                    </td>
                    <td className="px-4 py-2.5 text-fg">
                      {o.owner.displayName}
                      <span className="block text-xs break-all text-subtle">{o.owner.email}</span>
                    </td>
                    <td className="tnum px-4 py-2.5">{o.memberCount}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={STATUS_TONE[o.status] ?? 'neutral'}>{o.status}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-fg">{o.planName}</td>
                    <td className="px-4 py-2.5 text-muted">
                      {o.lastActiveAt ? formatDateTime(o.lastActiveAt) : 'Never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
