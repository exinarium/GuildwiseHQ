import { Link } from 'react-router';
import type { RelayOfflineNotice } from '../../lib/relay.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Callout } from '../ui/Callout.tsx';

const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
const sinceText = (iso: string) =>
  sameDay(iso)
    ? `since ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : `since ${formatDateTime(iso)}`;

/** Shown to every member while an active inbound webhook has no runner and the provider's requests were refused. */
export function RelayOfflineCallout({ notice }: { notice: RelayOfflineNotice }) {
  return (
    <Callout
      tone="warning"
      role="status"
      title="Runner offline: messages are waiting at the provider"
      data-testid="relay-offline-banner"
    >
      <ul className="list-disc pl-4">
        {notice.items.map((i) => (
          <li key={i.id} data-testid={`relay-offline-${i.id}`}>
            <strong>{i.label}</strong> has no connected runner {sinceText(i.since)}
            {i.refused > 0 && ` (${i.refused} ${i.refused === 1 ? 'request' : 'requests'} refused)`}.
          </li>
        ))}
      </ul>
      <p>
        The provider keeps the messages and sends them again. {notice.retryText} Start the runner on your
        workstation to receive them.{' '}
        <Link to="/workstations" className="font-medium underline" data-testid="relay-offline-link">
          Open Workstations
        </Link>
      </p>
    </Callout>
  );
}
