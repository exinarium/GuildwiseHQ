import { LogIn, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useFailedSignIns, useSignIns } from '../../../api/queries/security-log.ts';
import { Badge, EmptyState, ErrorBox, ListSkeleton, Panel, TextInput } from '../../../components/ui.tsx';
import { formatDateTime } from '../../../lib/time.ts';

/** `chrome/linux` -> "Chrome on Linux" (the server never sends the full user agent). */
export function describeUaFamily(family: string | null): string {
  if (!family) return 'unknown browser';
  const [b = 'other', o = 'other'] = family.split('/');
  const name: Record<string, string> = {
    chrome: 'Chrome',
    edge: 'Edge',
    firefox: 'Firefox',
    safari: 'Safari',
    opera: 'Opera',
    samsung: 'Samsung Internet',
    curl: 'curl',
    script: 'script',
    test: 'test client',
  };
  const os: Record<string, string> = {
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
    ios: 'iOS',
    android: 'Android',
    chromeos: 'ChromeOS',
  };
  return `${name[b] ?? 'unknown browser'} on ${os[o] ?? 'unknown system'}`;
}

const REASON: Record<string, string> = {
  password: 'Wrong password',
  second_factor: 'Wrong two-factor code',
  step_up: 'Wrong answer to "Confirm it\'s you"',
  reset_second_factor: 'Wrong code on a reset link',
  blocked: 'Refused by the block list',
  locked: 'Refused: locked',
  cleared: 'Lock cleared (reset)',
};

const METHOD: Record<string, string> = {
  password: 'Password',
  password_totp: 'Password and code',
  password_recovery: 'Password and recovery code',
  invitation: 'Invitation',
  email_verification: 'Email verification',
  demo: 'Demo',
};

function Filter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="mb-4 max-w-sm">
      <TextInput
        label="Filter by address or IP"
        placeholder="For example ada@example.com or 203.0.113."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** "Failed sign-ins": every wrong answer, refusal and cleared lock of the last 90 days, newest first, and the locks now. */
export function FailedSignInsPanel() {
  const [q, setQ] = useState('');
  const list = useFailedSignIns(q);
  return (
    <div className="pt-4" data-testid="failed-sign-ins">
      <Filter value={q} onChange={setQ} />
      {list.isPending && <ListSkeleton label="Loading failed sign-ins" rows={5} />}
      {list.isError && <ErrorBox error={list.error} />}
      {list.data && list.data.locks.length > 0 && (
        <Panel className="mb-4" data-testid="security-locks">
          <h2 className="mb-2 text-sm font-semibold text-fg">Locked now</h2>
          <ul className="space-y-1 text-sm">
            {list.data.locks.map((l) => (
              <li key={`${l.scope}:${l.key}`}>
                <Badge tone="warning">{l.scope === 'ip' ? 'IP' : 'Account'}</Badge>{' '}
                <span className="text-fg">{l.key}</span>{' '}
                <span className="text-subtle">
                  {l.failures} failures, until {formatDateTime(l.until)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {list.data?.items.length === 0 && (
        <EmptyState icon={ShieldAlert} title="No failed sign-ins to show" description="Nothing matches." />
      )}
      {list.data && list.data.items.length > 0 && (
        <Panel padding="none">
          <ul className="divide-y divide-line text-sm">
            {list.data.items.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <p className="text-fg">
                  {REASON[r.reason] ?? r.reason}
                  {' · '}
                  {r.email ?? 'no address'}
                  {r.userId ? '' : r.email ? ' (no account)' : ''}
                </p>
                <p className="text-xs text-subtle">
                  {formatDateTime(r.at)}
                  {r.ip ? ` · ${r.ip}` : ''}
                  {r.uaFamily ? ` · ${describeUaFamily(r.uaFamily)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

/** "Sign-ins": every session started (`SessionStarted`), newest first, with new devices marked. */
export function SignInsPanel() {
  const [q, setQ] = useState('');
  const list = useSignIns(q);
  return (
    <div className="pt-4" data-testid="sign-ins">
      <Filter value={q} onChange={setQ} />
      {list.isPending && <ListSkeleton label="Loading sign-ins" rows={5} />}
      {list.isError && <ErrorBox error={list.error} />}
      {list.data?.items.length === 0 && (
        <EmptyState icon={LogIn} title="No sign-ins to show" description="Nothing matches." />
      )}
      {list.data && list.data.items.length > 0 && (
        <Panel padding="none">
          <ul className="divide-y divide-line text-sm">
            {list.data.items.map((r) => (
              <li key={r.seq} className="px-4 py-3">
                <p className="text-fg">
                  {r.displayName ?? 'a user'} {r.email ? `<${r.email}>` : ''}
                  {r.kind === 'super_admin' && (
                    <>
                      {' '}
                      <Badge tone="info">Super admin</Badge>
                    </>
                  )}
                  {r.newDevice && (
                    <>
                      {' '}
                      <Badge tone="warning">New device</Badge>
                    </>
                  )}
                </p>
                <p className="text-xs text-subtle">
                  {formatDateTime(r.at)} · {METHOD[r.method] ?? r.method}
                  {r.ip ? ` · ${r.ip}` : ''} · {describeUaFamily(r.uaFamily)}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
