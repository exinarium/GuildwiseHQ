import { useState } from 'react';
import { downloadAuditExport } from '../../api/queries/governance.ts';
import { useOrgMembers } from '../../api/queries/orgs.ts';
import { Button, Callout, ErrorBox, Panel, Select, TextInput, useToast } from '../ui.tsx';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Audit log export for the Owner and Admins: CSV or JSON, a date range, one person. Streamed by the server; secrets are masked. */
export function AuditTab() {
  const members = useOrgMembers();
  const toast = useToast();
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [actor, setActor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Panel title="Audit log">
      <div className="flex flex-col gap-4" data-testid="audit-export">
        <p className="text-sm text-muted">
          Export what people did in this organization: who changed what, who decided what, who was added or
          removed. Message text, drafts and other content are not part of it, and anything that looks like a
          secret is masked. Each export is itself recorded here.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label="From"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextInput
            label="Up to and including"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
          <Select label="Person" value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">Everyone</option>
            {(members.data ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
              </option>
            ))}
          </Select>
          <Select label="Format" value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'json')}>
            <option value="csv">CSV (spreadsheet)</option>
            <option value="json">JSON</option>
          </Select>
        </div>
        <Callout tone="info">One export covers up to a year. For more, export in pieces.</Callout>
        <div>
          <Button
            variant="primary"
            loading={busy}
            disabled={!from || !to || from > to}
            onClick={() => {
              setBusy(true);
              setError(null);
              downloadAuditExport({ format, from, to, ...(actor ? { actorUserId: actor } : {}) })
                .then((name) => toast.success(`Exported ${name}`))
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          >
            Download
          </Button>
        </div>
        <ErrorBox error={error} />
      </div>
    </Panel>
  );
}
