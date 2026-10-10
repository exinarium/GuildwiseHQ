import type { OrgDetailResponse } from '@aom/shared';
import { Callout, Panel, StatusDot } from '../ui.tsx';

const FEATURE_LABEL: Record<string, string> = {
  interests: 'Interests',
  integrations: 'Integrations and intake',
  outbound: 'Outbound updates',
  research: 'Research',
  phases: 'Phases',
  browserTools: 'Browser tools',
  customRoles: 'Custom roles and workflows',
};
const USAGE: Array<{
  key: 'members' | 'projects' | 'workstations';
  label: string;
  limit: string;
}> = [
  { key: 'members', label: 'Members', limit: 'maxMembers' },
  { key: 'projects', label: 'Projects', limit: 'maxProjects' },
  { key: 'workstations', label: 'Workstations', limit: 'maxWorkstations' },
];

const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null;

/** Read-only plan, status, usage against the limits and feature flags, for the Owner and Admins. */
export function PlanTab({ org }: { org: OrgDetailResponse }) {
  const limits = org.limits;
  const usage = org.usage;
  const lic = day(org.licenseExpiresAt);
  const trial = day(org.trialEndsAt);
  return (
    <div className="flex flex-col gap-5">
      <Panel data-testid="plan-summary">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-subtle">Plan</dt>
            <dd className="mt-0.5 text-base font-semibold text-fg">{org.planName}</dd>
          </div>
          <div>
            <dt className="text-subtle">Status</dt>
            <dd className="mt-0.5 text-base font-semibold text-fg">
              <StatusDot tone={org.status === 'active' || org.status === 'trial' ? 'success' : 'danger'}>
                <span className="text-fg capitalize">{org.status}</span>
              </StatusDot>
            </dd>
          </div>
          <div>
            <dt className="text-subtle">Licence</dt>
            <dd className="mt-0.5 text-base font-semibold text-fg">
              {org.status === 'trial' && trial
                ? `Trial until ${trial}`
                : lic
                  ? `Expires ${lic}`
                  : 'No expiry'}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Usage" padding="none">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-subtle">
              <tr>
                <th className="px-4 py-2 font-medium">Resource</th>
                <th className="px-4 py-2 font-medium">Used</th>
                <th className="px-4 py-2 font-medium">Limit</th>
                <th className="w-2/5 px-4 py-2 font-medium">Capacity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {USAGE.map((u) => {
                const used = usage?.[u.key] ?? 0;
                const max = (limits as Record<string, number | null> | undefined)?.[u.limit] ?? null;
                const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
                const full = max !== null && used >= max;
                return (
                  <tr key={u.key} data-testid={`usage-${u.key}`}>
                    <td className="px-4 py-2.5 font-medium text-fg">{u.label}</td>
                    <td className="tnum px-4 py-2.5 text-fg">{used}</td>
                    <td className="tnum px-4 py-2.5 text-muted">{max ?? 'Unlimited'}</td>
                    <td className="px-4 py-2.5">
                      {max === null ? (
                        <span className="text-xs text-subtle">no limit</span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <span
                            role="progressbar"
                            aria-label={`${u.label} used`}
                            aria-valuenow={used}
                            aria-valuemin={0}
                            aria-valuemax={max}
                            className="h-2 flex-1 overflow-hidden rounded-full bg-sunken"
                          >
                            <span
                              className={`block h-full rounded-full ${full ? 'bg-warning-fill' : 'bg-brand'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </span>
                          <span
                            className={`w-12 text-xs ${full ? 'font-semibold text-warning-soft-fg' : 'text-subtle'}`}
                          >
                            {full ? 'Full' : `${pct}%`}
                          </span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-4 py-2.5 text-xs text-subtle">
          Guests and DevOps engineers do not count against the limits.
        </p>
      </Panel>

      <Panel title="Features">
        <ul className="grid gap-2 text-sm sm:grid-cols-2" data-testid="features">
          {Object.entries(org.features).map(([k, on]) => (
            <li key={k}>
              <StatusDot tone={on ? 'success' : 'neutral'}>
                <span className="text-fg">{FEATURE_LABEL[k] ?? k}</span>{' '}
                <span className="text-subtle">{on ? 'on' : 'off'}</span>
              </StatusDot>
            </li>
          ))}
        </ul>
      </Panel>
      <Callout tone="info">To change your plan or limits, contact your platform administrator.</Callout>
    </div>
  );
}
