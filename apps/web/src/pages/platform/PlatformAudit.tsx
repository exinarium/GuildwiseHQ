import { ScrollText } from 'lucide-react';
import { useState } from 'react';
import { usePlatformAudit } from '../../api/queries/platform.ts';
import {
  Button,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  TextInput,
} from '../../components/ui.tsx';
import { formatDateTime } from '../../lib/time.ts';

/** `/platform/audit`: what the platform administrators and the system did, kept forever. */
export function PlatformAudit() {
  const [action, setAction] = useState('');
  const [before, setBefore] = useState<number | undefined>();
  const audit = usePlatformAudit({ action: action || undefined, before });
  return (
    <div>
      <PageHeader
        title="Audit log"
        sub="Every platform administrator action and every licensing action by the system. Kept forever."
      />
      <div className="mb-4 max-w-sm">
        <TextInput
          label="Filter by action"
          placeholder="For example OrgSuspended"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setBefore(undefined);
          }}
        />
      </div>
      {audit.isPending && <ListSkeleton label="Loading audit log" rows={5} />}
      {audit.isError && <ErrorBox error={audit.error} />}
      {audit.data?.rows.length === 0 && (
        <EmptyState icon={ScrollText} title="Nothing recorded" description="No entries match." />
      )}
      {audit.data && audit.data.rows.length > 0 && (
        <Panel padding="none">
          <ul className="divide-y divide-line text-sm" data-testid="platform-audit">
            {audit.data.rows.map((r) => (
              <li key={r.seq} className="px-4 py-3">
                <p className="text-fg">{r.summary}</p>
                <p className="text-xs text-subtle">
                  {formatDateTime(r.at)} · {r.actorName ?? r.actorKind} · {r.action}
                  {r.orgName ? ` · ${r.orgName}` : ''}
                  {r.ip ? ` · ${r.ip}` : ''}
                </p>
              </li>
            ))}
          </ul>
          {audit.data.next !== null && (
            <div className="border-t border-line p-3">
              <Button variant="secondary" size="sm" onClick={() => setBefore(audit.data.next ?? undefined)}>
                Older entries
              </Button>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
