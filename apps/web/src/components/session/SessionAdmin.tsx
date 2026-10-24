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
}: {
  threadId: string;
  archived: boolean;
  backTo: string;
  /** A running boardroom is ended before it is archived. */
  canArchive?: boolean;
}) {
  const nav = useNavigate();
  const archive = useArchiveSession(threadId);
  const remove = useDeleteSession(threadId);
  const [confirm, setConfirm] = useState(false);
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
      ) : (
        canArchive && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => archive.mutate(true)}
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
