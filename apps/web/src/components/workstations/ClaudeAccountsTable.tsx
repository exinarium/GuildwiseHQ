import type { WorkstationDto } from '@aom/shared';
import { formatUntil } from '../UsageLimitBanner.tsx';
import { Badge } from '../ui.tsx';

const LOGIN: Record<string, string> = { ok: 'Signed in', expired: 'Login expired', none: 'Not signed in' };

/**
 * The Claude accounts a workstation's runner reports (docs/design/claude-accounts.md 2.7): the main account and one per
 * project account, with login and usage. Shown only when there is something beyond the main account.
 */
export function ClaudeAccountsTable({ runtimes }: { runtimes: WorkstationDto['runtimes'] }) {
  const accounts = runtimes.find((r) => r.id === 'claude-code')?.accounts ?? [];
  if (accounts.length === 0 || (accounts.length === 1 && accounts[0]?.main)) return null;
  return (
    <div className="mt-3" data-testid="claude-accounts-table">
      <p className="mb-1 text-xs font-medium text-subtle">Claude accounts</p>
      <ul className="flex flex-col gap-2 md:hidden" data-testid="claude-accounts-cards">
        {accounts.map((a) => (
          <li key={a.key} className="rounded-control border border-line bg-canvas p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-fg">{a.main ? 'Main account' : a.key}</span>
              <Badge tone={a.login === 'ok' ? 'green' : 'neutral'}>{LOGIN[a.login] ?? a.login}</Badge>
            </div>
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-subtle">Signed in as</dt>
              <dd className="min-w-0 text-muted [overflow-wrap:anywhere]">
                {a.email ? `${a.email}${a.plan ? ` (${a.plan})` : ''}` : (a.plan ?? '-')}
              </dd>
              <dt className="text-subtle">Folder</dt>
              <dd className="min-w-0 font-mono text-muted [overflow-wrap:anywhere]">{a.configDir ?? '-'}</dd>
              <dt className="text-subtle">Usage</dt>
              <dd className="text-muted">
                {a.usage === 'limited'
                  ? `Limited${a.limitedUntil ? ` until ${formatUntil(a.limitedUntil)}` : ''}`
                  : 'Available'}
              </dd>
            </dl>
          </li>
        ))}
      </ul>
      <div className="overflow-x-auto max-md:hidden">
        <table className="w-full text-left text-xs">
          <thead className="text-subtle">
            <tr>
              <th className="pr-3 font-medium">Account</th>
              <th className="pr-3 font-medium">Folder</th>
              <th className="pr-3 font-medium">Signed in as</th>
              <th className="pr-3 font-medium">Login</th>
              <th className="font-medium">Usage</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.key} data-testid={`claude-account-row-${a.key}`}>
                <td className="pr-3 py-0.5 font-medium text-fg">{a.main ? 'Main account' : a.key}</td>
                <td className="pr-3 font-mono text-muted">{a.configDir ?? '-'}</td>
                <td className="pr-3 text-muted">
                  {a.email ? `${a.email}${a.plan ? ` (${a.plan})` : ''}` : (a.plan ?? '-')}
                </td>
                <td className="pr-3">
                  <Badge tone={a.login === 'ok' ? 'green' : 'neutral'}>{LOGIN[a.login] ?? a.login}</Badge>
                </td>
                <td>
                  {a.usage === 'limited'
                    ? `Limited${a.limitedUntil ? ` until ${formatUntil(a.limitedUntil)}` : ''}`
                    : 'Available'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
