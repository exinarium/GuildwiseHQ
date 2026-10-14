import { ACTION_CLASSES, type CeoActionDto } from '@aom/shared';
import { CheckCircle2, CircleSlash, Lightbulb } from 'lucide-react';
import { useState } from 'react';
import { type CeoActionFilters, ceoActionsCsvUrl, useCeoActions } from '../../api/queries/ceo.ts';
import { getActiveOrgId } from '../../lib/activeOrg.ts';
import { classLabel, MODE_LABEL, pct } from '../../lib/ceo.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Button, ErrorBox, Panel, Select, Spinner, TextInput } from '../ui.tsx';
import { UndoButton } from './UndoButton.tsx';

const RESPONSE: Record<string, string> = {
  accepted: 'You accepted it',
  accepted_changed: 'You accepted it with a change',
  rejected: 'You rejected it',
  different: 'You decided differently',
};

const MODE_TONE = { decided: 'green', recommended: 'blue', refused: 'red' } as const;
const MODE_ICON = { decided: CheckCircle2, recommended: Lightbulb, refused: CircleSlash } as const;

function ModeBadge({ a }: { a: CeoActionDto }) {
  const Icon = MODE_ICON[a.mode];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={MODE_TONE[a.mode]} icon={<Icon aria-hidden="true" />} data-testid="ceo-action-mode">
        {MODE_LABEL[a.mode]}
      </Badge>
      {a.status === 'undone' && <Badge tone="amber">Undone</Badge>}
    </span>
  );
}

function ActionRow({ a, owner }: { a: CeoActionDto; owner: boolean }) {
  return (
    <tr className="align-top" data-testid="ceo-action" data-mode={a.mode} data-status={a.status}>
      <td className="px-3 py-2 text-xs whitespace-nowrap text-muted">{formatDateTime(a.at)}</td>
      <td className="px-3 py-2 font-medium text-fg">{a.classLabel || classLabel(a.class)}</td>
      <td className="px-3 py-2">
        <ModeBadge a={a} />
      </td>
      <td className="px-3 py-2 text-fg">{a.subjectLabel}</td>
      <td className="max-w-xs px-3 py-2 text-muted">
        {a.reason}
        {a.mode !== 'decided' && a.verdictReason && (
          <span className="block text-xs text-subtle">{a.verdictReason}</span>
        )}
      </td>
      <td className="tnum px-3 py-2 text-muted">{pct(a.confidence)}</td>
      <td className="tnum px-3 py-2 text-muted">v{a.policyVersion}</td>
      <td className="px-3 py-2 text-xs text-muted">
        {a.evidence.length === 0 ? (
          '-'
        ) : (
          <details>
            <summary className="cursor-pointer">{a.evidence.length} cited</summary>
            <ul className="mt-1 list-disc pl-4">
              {a.evidence.map((e) => (
                <li key={e} className="[overflow-wrap:anywhere]">
                  {e}
                </li>
              ))}
            </ul>
          </details>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted">
        {a.mode === 'recommended'
          ? a.response
            ? `${RESPONSE[a.response] ?? a.response}${a.responseNote ? `: ${a.responseNote}` : ''}`
            : 'Waiting for you'
          : '-'}
      </td>
      <td className="px-3 py-2">
        {a.status === 'undone' ? (
          <span className="text-xs text-muted">Undone {formatDateTime(a.undoneAt)}</span>
        ) : a.undo.available && owner ? (
          <UndoButton actionId={a.id} what={a.undo.label ?? a.subjectLabel} />
        ) : a.undo.available ? (
          <span className="text-xs text-muted">{a.undo.label ?? 'Can be undone by the Owner'}</span>
        ) : a.undo.reason ? (
          <span className="text-xs text-muted" data-testid="ceo-undo-reason">
            {a.undo.reason}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function ActionsPage({
  filters,
  before,
  owner,
  first,
}: {
  filters: CeoActionFilters;
  before?: string;
  owner: boolean;
  first: boolean;
}) {
  const q = useCeoActions(filters, before);
  const [more, setMore] = useState(false);
  if (q.isPending)
    return (
      <tbody>
        <tr>
          <td colSpan={10} className="p-4">
            <Spinner label="Loading the activity" />
          </td>
        </tr>
      </tbody>
    );
  if (!q.data)
    return (
      <tbody>
        <tr>
          <td colSpan={10} className="p-4">
            <ErrorBox error={q.error} onRetry={() => q.refetch()} />
          </td>
        </tr>
      </tbody>
    );
  const { actions, next } = q.data;
  return (
    <>
      <tbody className="divide-y divide-line">
        {first && actions.length === 0 && (
          <tr>
            <td colSpan={10} className="p-6 text-center text-sm text-muted" data-testid="ceo-actions-empty">
              No actions match.
            </td>
          </tr>
        )}
        {actions.map((a) => (
          <ActionRow key={a.id} a={a} owner={owner} />
        ))}
        {next && !more && (
          <tr>
            <td colSpan={10} className="p-3 text-center">
              <Button onClick={() => setMore(true)} data-testid="ceo-actions-more">
                Load older actions
              </Button>
            </td>
          </tr>
        )}
      </tbody>
      {next && more && <ActionsPage filters={filters} before={next} owner={owner} first={false} />}
    </>
  );
}

async function downloadCsv(url: string): Promise<void> {
  const headers: Record<string, string> = {};
  const org = getActiveOrgId();
  if (org) headers['x-aom-org'] = org;
  const res = await fetch(url, { credentials: 'include', headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = 'ceo-activity.csv';
  a.click();
  URL.revokeObjectURL(href);
}

/** Everything the CEO decided, recommended or refused, with how you answered and an Undo where one exists. */
export function ActivityTab({ owner }: { owner: boolean }) {
  const [cls, setCls] = useState('');
  const [mode, setMode] = useState('');
  const [subject, setSubject] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [csvError, setCsvError] = useState<string | null>(null);
  const filters: CeoActionFilters = {
    ...(cls ? { class: cls } : {}),
    ...(mode ? { mode } : {}),
    ...(subject.trim() ? { subject: subject.trim() } : {}),
    ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
    ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}),
  };
  const csv = ceoActionsCsvUrl(filters);
  const key = JSON.stringify(filters);

  return (
    <div className="flex flex-col gap-4" data-testid="ceo-activity">
      <Panel>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Select label="Kind of action" value={cls} onChange={(e) => setCls(e.target.value)}>
            <option value="">All</option>
            {ACTION_CLASSES.map((c) => (
              <option key={c} value={c}>
                {classLabel(c)}
              </option>
            ))}
          </Select>
          <Select label="Outcome" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">All</option>
            <option value="decided">Decided</option>
            <option value="recommended">Recommended</option>
            <option value="refused">Refused</option>
          </Select>
          <TextInput
            label="Subject"
            value={subject}
            maxLength={100}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="TOY-4, an agent name"
          />
          <TextInput label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <TextInput label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <p className="mt-3 text-sm">
          <a
            href={csv}
            download="ceo-activity.csv"
            data-testid="ceo-csv"
            className="font-medium text-brand-text hover:underline"
            onClick={(e) => {
              e.preventDefault();
              setCsvError(null);
              downloadCsv(csv).catch((err: unknown) =>
                setCsvError(err instanceof Error ? err.message : 'The export failed'),
              );
            }}
          >
            Export as CSV
          </a>
          {csvError && (
            <span role="alert" className="ml-2 text-danger">
              {csvError}
            </span>
          )}
        </p>
      </Panel>
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full text-left text-sm" aria-label="Activity log">
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              {[
                'Time',
                'Action',
                'Outcome',
                'Subject',
                'Reason',
                'Confidence',
                'Policy',
                'Evidence',
                'Your response',
                'Undo',
              ].map((h) => (
                <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <ActionsPage key={key} filters={filters} owner={owner} first />
        </table>
      </div>
      {!owner && <p className="text-sm text-muted">Only the Owner can undo an action.</p>}
    </div>
  );
}
