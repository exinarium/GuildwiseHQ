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
      <div className="overflow-x-auto">
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
