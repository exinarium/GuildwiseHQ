import { Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useArchiveSession, useDeleteSession } from '../../api/queries/sessions.ts';
import { Button, Callout, ConfirmDialog, ErrorBox } from '../ui.tsx';

/** Archive (read-only) and delete: for the session's creator, an Owner or an Admin. */
export function SessionAdmin({
  threadId,
  archived,
  backTo,
  canArchive = true,
  endFirst = false,
  archivePending = false,
}: {
  threadId: string;
  archived: boolean;
  backTo: string;
  canArchive?: boolean;
  /** A running boardroom: archiving asks first, ends it (the minutes are written) and then archives it (Q53). */
  endFirst?: boolean;
  /** The boardroom is writing its minutes and will be archived when they are ready. */
  archivePending?: boolean;
}) {
  const nav = useNavigate();
  const archive = useArchiveSession(threadId);
  const remove = useDeleteSession(threadId);
  const [confirm, setConfirm] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="session-admin">
      {archived ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => archive.mutate(false)}
          loading={archive.isPending}
          data-testid="reopen-session"
        >
          <ArchiveRestore aria-hidden="true" className="size-4" />
          Reopen
        </Button>
      ) : archivePending ? (
        <span className="text-sm text-muted" role="status" data-testid="archive-pending">
          Writing the minutes, then it is archived.
        </span>
      ) : (
        canArchive && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => (endFirst ? setConfirmEnd(true) : archive.mutate(true))}
            loading={archive.isPending}
            data-testid="archive-session"
          >
            <Archive aria-hidden="true" className="size-4" />
            Archive
          </Button>
        )
      )}
      <Button size="sm" variant="danger-ghost" onClick={() => setConfirm(true)} data-testid="delete-session">
        <Trash2 aria-hidden="true" className="size-4" />
        Delete
      </Button>
      <ErrorBox error={archive.error} />
      <ConfirmDialog
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title="End this boardroom and archive it?"
        description="The boardroom is still running. It ends now, the Chair writes the minutes as when you click End, and the session is archived when they are ready."
        confirmLabel="End and archive"
        pending={archive.isPending}
        onConfirm={() =>
          archive.mutate({ archived: true, endFirst: true }, { onSuccess: () => setConfirmEnd(false) })
        }
      />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this session?"
        description="It disappears for everyone, with its messages. This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined, { onSuccess: () => nav(backTo) })}
      />
    </div>
  );
}

/** The banner of an archived session. */
export function ArchivedBanner({ children }: { children?: React.ReactNode }) {
  return (
    <Callout tone="info" role="status" title="Archived" data-testid="archived-banner">
      This session is read-only. {children}
    </Callout>
  );
}
