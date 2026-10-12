import type { DevOpsRequestContext, DevOpsRequestDto } from '@aom/shared';
import { Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useCreateDevOpsRequest, useDevOpsRequests } from '../../api/queries/devops.ts';
import { Badge, Button, ErrorBox } from '../ui.tsx';

type Tone = 'neutral' | 'blue' | 'amber' | 'green' | 'red';

/** What the owner sees for a request's status (the DevOps queue calls them queued / running / ...). */
const STATUS: Record<DevOpsRequestDto['status'], { tone: Tone; label: string }> = {
  queued: { tone: 'neutral', label: 'Requested' },
  running: { tone: 'blue', label: 'DevOps is working on it' },
  needs_approval: { tone: 'amber', label: 'Needs your approval on the desk' },
  done: { tone: 'green', label: 'Done' },
  failed: { tone: 'red', label: 'DevOps could not fix it' },
};
const ACTIVE = new Set<DevOpsRequestDto['status']>(['queued', 'running', 'needs_approval']);

/**
 * The **Fix** button next to a failed or missing item (a tool of the development environment, a right on the machine,
 * a clone that failed). It files a DevOps request for the workstation with the problem as the instruction and the
 * error text, workstation, project and repository as context, shows the request's progress right here, and calls
 * `onDone` once when DevOps reports done so the caller can run the check again. A request that is still open for the
 * same problem is picked up again after a reload instead of filing a second one.
 */
export function FixWithDevOps({
  workstationId,
  problem,
  errorText,
  suggestedFix,
  projectId,
  repoId,
  onDone,
  doneLabel = 'Check again',
}: {
  workstationId: string;
  /** One line naming what is broken, for example "dotnet (dotnet-maui) is missing on Desk". */
  problem: string;
  /** The error text of the check: its reason or detail. */
  errorText?: string | undefined;
  /** The "How to fix" the check suggested, if any. */
  suggestedFix?: string | undefined;
  projectId?: string | undefined;
  repoId?: string | undefined;
  /** Runs the check again; called once when the request is done. */
  onDone?: (() => void) | undefined;
  doneLabel?: string;
}) {
  const create = useCreateDevOpsRequest();
  const requests = useDevOpsRequests(workstationId);
  const summary = [
    `Fix this problem on this workstation: ${problem}.`,
    errorText ? `What the check reported: ${errorText}` : '',
    suggestedFix ? `Suggested fix: ${suggestedFix}` : '',
    'Fix it within your granted access (ask for approval otherwise). When you are done, say what you changed.',
  ]
    .filter(Boolean)
    .join('\n');
  const [requestId, setRequestId] = useState<string | undefined>();

  // Pick up a request for this same problem that is still open (after a reload, or from another tab).
  const open = requestId
    ? undefined
    : (requests.data ?? []).find((r) => r.summary === summary && ACTIVE.has(r.status));
  useEffect(() => {
    if (open) setRequestId(open.id);
  }, [open]);

  const request = requestId ? requests.data?.find((r) => r.id === requestId) : undefined;
  const doneFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (request?.status === 'done' && doneFor.current !== request.id) {
      doneFor.current = request.id;
      onDone?.();
    }
  }, [request?.id, request?.status, onDone]);

  const send = () => {
    const context: DevOpsRequestContext = {
      workstationId,
      ...(projectId ? { projectId } : {}),
      ...(repoId ? { repoId } : {}),
      ...(errorText ? { errorText: errorText.slice(0, 4000) } : {}),
      route: `${window.location.pathname}${window.location.search}`,
    };
    create.mutate(
      { workstationId, summary, origin: 'workstation', context },
      { onSuccess: (d) => setRequestId(d.request.id) },
    );
  };

  const pending = create.isPending || (!!requestId && !request && requests.isPending);
  const active = request ? ACTIVE.has(request.status) : false;
  const s = request ? STATUS[request.status] : undefined;
  return (
    <span
      className="inline-flex flex-wrap items-center gap-2"
      data-testid="fix-with-devops"
      data-status={request?.status ?? 'none'}
    >
      {!active && (
        <Button
          size="sm"
          loading={pending}
          onClick={send}
          aria-label={`${request ? 'Fix again' : 'Fix'}: ${problem}`}
        >
          <Wrench aria-hidden="true" className="size-3.5" />
          {request ? 'Fix again' : 'Fix'}
        </Button>
      )}
      {s && (
        <span role="status" className="inline-flex flex-wrap items-center gap-1.5 text-xs">
          <Badge tone={s.tone}>{s.label}</Badge>
          {request?.status === 'done' && request.resultSummary && (
            <span className="text-muted">{request.resultSummary}</span>
          )}
        </span>
      )}
      {request?.status === 'done' && onDone && (
        <Button size="sm" onClick={onDone}>
          {doneLabel}
        </Button>
      )}
      <ErrorBox error={create.error} />
    </span>
  );
}
