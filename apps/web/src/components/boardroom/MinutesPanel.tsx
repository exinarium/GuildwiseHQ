import type { BoardStateDto } from '@aom/shared';
import { ArrowRight, FileText, ScrollText } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { usePullIntoPrd, useWriteMinutes } from '../../api/queries/boardroom.ts';
import { DocumentBody } from '../discovery/DraftPanel.tsx';
import { Button, ErrorBox } from '../ui.tsx';

/** The minutes: the document the Chair wrote, "Write minutes now", and "Pull into PRD" (a Discovery session seeded from them). */
export function MinutesPanel({ state, canManage }: { state: BoardStateDto; canManage: boolean }) {
  const nav = useNavigate();
  const docId = state.config.minutesDocId;
  const minutes = useWriteMinutes(state.threadId);
  const pull = usePullIntoPrd(state.threadId);
  const running = state.waitingFor === 'minutes';
  const canWrite = state.config.stage !== 'setup' && state.config.round >= 1 && !running;
  return (
    <div className="flex flex-col gap-3" data-testid="minutes-panel">
      <div className="flex flex-wrap items-center gap-2">
        {canWrite && (
          <Button
            size="sm"
            onClick={() => minutes.mutate()}
            loading={minutes.isPending}
            data-testid="write-minutes"
          >
            <ScrollText aria-hidden="true" className="size-4" />
            {docId ? 'Update the minutes' : 'Write minutes now'}
          </Button>
        )}
        {docId && canManage && !state.config.prdSessionId && (
          <Button
            variant="primary"
            size="sm"
            loading={pull.isPending}
            data-testid="pull-into-prd"
            onClick={() => pull.mutate(undefined, { onSuccess: (r) => nav(`/discovery/${r.discoveryId}`) })}
          >
            <ArrowRight aria-hidden="true" className="size-4" />
            Pull into PRD
          </Button>
        )}
        {state.config.prdSessionId && (
          <Link
            to={`/discovery/${state.config.prdSessionId}`}
            className="text-sm text-brand-text underline-offset-2 hover:underline"
            data-testid="open-prd-session"
          >
            Open the PRD session
          </Link>
        )}
        {docId && (
          <Link
            to={`/documents/${docId}`}
            className="inline-flex items-center gap-1 text-sm text-brand-text underline-offset-2 hover:underline"
          >
            <FileText aria-hidden="true" className="size-4" />
            Open in Documents
          </Link>
        )}
      </div>
      <ErrorBox error={minutes.error ?? pull.error} />
      {running && <p className="text-sm text-muted">The Chair is writing the minutes…</p>}
      {!docId && !running && (
        <p className="text-sm text-muted">
          No minutes yet. They are written when the session ends, or whenever you ask.
        </p>
      )}
      {docId && (
        <article
          aria-label="Minutes"
          data-testid="minutes-body"
          className="max-h-[60vh] overflow-y-auto rounded-card border border-line bg-surface p-3"
        >
          <DocumentBody id={docId} versions={false} />
        </article>
      )}
    </div>
  );
}
