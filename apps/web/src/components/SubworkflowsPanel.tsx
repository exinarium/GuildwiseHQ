import type {
  CardDetailResponse,
  SubworkflowChildDto,
  SubworkflowsPanel as SubworkflowsData,
} from '@aom/shared';
import { Link } from 'react-router';
import { Badge, Callout, Panel } from './ui.tsx';

const STATE_LABEL: Record<SubworkflowChildDto['state'], string> = {
  open: 'Running',
  continued: 'Started, not waited for',
  done: 'Finished',
  cancelled: 'Cancelled',
};
const STATE_TONE = { open: 'warning', continued: 'info', done: 'success', cancelled: 'danger' } as const;

const valueText = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);

/** "SUP-12 (Translate) in project Web", or only the ref and project key when the viewer may not see the child. */
export function childLabel(c: SubworkflowChildDto['child']): string {
  return c.visible
    ? `${c.ref} (${c.title}) in project ${c.projectName}`
    : `${c.ref} in project ${c.projectKey}`;
}

/** The open children a waiting card could take down with it: the viewer may cancel them (offered when cancelling the card). */
export function cancellableChildren(
  status: string,
  data: SubworkflowsData | undefined,
): SubworkflowChildDto[] {
  if (status !== 'waiting') return [];
  return (data?.children ?? []).filter((c) => c.state === 'open' && c.child.canCancel === true);
}

/** The card is waiting for a sub-workflow child: a line above the card, with the child's current column. */
export function SubworkflowWaitLine({ data }: { data: SubworkflowsData | undefined }) {
  const open = data?.children.filter((c) => c.state === 'open' && c.mode === 'wait') ?? [];
  if (open.length === 0) return null;
  return (
    <Callout tone="info" role="status" data-testid="subworkflow-wait" className="mb-4">
      {open.map((c, i) => (
        <span key={c.child.id}>
          {i > 0 && ', '}
          Waiting for{' '}
          {c.child.visible ? (
            <Link to={`/cards/${c.child.id}`} className="font-medium underline">
              {c.child.ref}
            </Link>
          ) : (
            <span className="font-medium">{c.child.ref}</span>
          )}
          {c.child.visible ? ` (${c.child.title})` : ''} in project{' '}
          {c.child.visible ? c.child.projectName : c.child.projectKey}
          {c.child.column ? `, now in ${c.child.column}` : ''}
        </span>
      ))}
      . This card carries on when it ends.
    </Callout>
  );
}

/** "Started by APP-41" on a card a sub-workflow step created. */
export function StartedByLine({ data }: { data: SubworkflowsData | undefined }) {
  const by = data?.startedBy;
  if (!by) return null;
  return (
    <p className="mb-3 text-sm text-muted" data-testid="subworkflow-started-by">
      Started by{' '}
      {by.visible ? (
        <Link to={`/cards/${by.id}`} className="font-medium underline">
          {by.ref}
        </Link>
      ) : (
        <span className="font-medium">{by.ref}</span>
      )}
      {by.visible && by.title ? ` (${by.title})` : ''}, step "{by.stageLabel}" in project {by.projectKey}.
    </p>
  );
}

/** Card detail: the child cards this card's sub-workflow steps started, with their status and the fields passed on. */
export function SubworkflowsPanel({ data }: { data: SubworkflowsData | undefined }) {
  if (!data || data.children.length === 0) return null;
  return (
    <Panel title="Sub-workflows" data-testid="subworkflows-panel">
      <ul className="flex flex-col divide-y divide-line">
        {data.children.map((c) => {
          const passed = Object.entries(c.child.fields);
          const back = Object.entries(c.fieldsBack);
          return (
            <li
              key={c.child.id}
              className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0"
              data-testid={`subworkflow-${c.child.ref}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-fg">{c.stageLabel}</span>
                <Badge tone={STATE_TONE[c.state]}>{STATE_LABEL[c.state]}</Badge>
                <Badge>{c.mode === 'wait' ? 'waits for it' : 'carries on'}</Badge>
              </div>
              <p className="text-sm">
                {c.child.visible ? (
                  <Link
                    to={`/cards/${c.child.id}`}
                    className="font-medium underline"
                    data-testid={`subworkflow-link-${c.child.ref}`}
                  >
                    {c.child.ref}
                  </Link>
                ) : (
                  <span className="font-medium">{c.child.ref}</span>
                )}
                {c.child.visible ? ` ${c.child.title}` : ''}{' '}
                <span className="text-subtle">
                  {c.workflowKey} v{c.workflowVersion}, project {c.child.projectName}
                  {c.child.visible && c.child.column ? `, in ${c.child.column}` : ''}
                </span>
              </p>
              {c.child.visible && passed.length > 0 && (
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 text-xs text-muted">
                  {passed.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="font-medium">{k}</dt>
                      <dd className="min-w-0 truncate">{valueText(v)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {back.length > 0 && (
                <p className="text-xs text-muted" data-testid="subworkflow-fields-back">
                  Copied back: {back.map(([k, v]) => `${k} = ${valueText(v)}`).join(', ')}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/**
 * Repository scoping: a card the BA split is cancelled and lists the cards that replaced it; one of those cards links back.
 * Nothing is shown for a card that was not split.
 */
export function SplitLinks({
  splitInto,
  splitFrom,
}: {
  splitInto: CardDetailResponse['splitInto'];
  splitFrom: CardDetailResponse['splitFrom'];
}) {
  if (!splitInto?.length && !splitFrom) return null;
  return (
    <div data-testid="split-links" className="mb-4 flex flex-col gap-2">
      {splitInto && splitInto.length > 0 && (
        <Callout tone="info" role="status" title="Split into">
          <ul className="mt-1 flex flex-col gap-1">
            {splitInto.map((c) => (
              <li key={c.id} data-testid={`split-into-${c.ref}`}>
                <Link to={`/cards/${c.id}`} className="font-medium underline">
                  {c.ref}
                </Link>{' '}
                {c.title}
                {c.repoName ? ` (${c.repoName})` : ''} <Badge>{c.status}</Badge>
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {splitFrom && (
        <p className="text-sm text-muted" data-testid="split-from">
          Split from{' '}
          <Link to={`/cards/${splitFrom.id}`} className="font-medium underline">
            {splitFrom.ref}
          </Link>
          .
        </p>
      )}
    </div>
  );
}
