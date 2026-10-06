import { useAnswerShare, useProjectInvitations } from '../api/queries/members.ts';
import { formatDateTime } from '../lib/time.ts';
import { Button, ErrorBox, Panel } from './ui.tsx';

/** Inbox of project shares waiting for an answer. Accepting makes you an additional manager of that project. */
export function ProjectInvitations() {
  const q = useProjectInvitations();
  const answer = useAnswerShare();
  const list = q.data ?? [];
  if (list.length === 0) return null;
  return (
    <Panel className="mb-3 border-brand/50">
      <h2 className="mb-2 text-sm font-semibold">Project invitations</h2>
      <ul className="flex flex-col gap-2" data-testid="project-invitations">
        {list.map((i) => (
          <li
            key={i.projectId}
            data-testid={`invitation-${i.projectKey}`}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <span className="min-w-0 flex-1">
              <strong>{i.invitedByName}</strong> invited you to manage{' '}
              <strong>
                {i.projectKey} {i.projectName}
              </strong>
              {i.invitedAt && <span className="text-xs text-subtle"> · {formatDateTime(i.invitedAt)}</span>}
            </span>
            <Button
              variant="primary"
              disabled={answer.isPending}
              aria-label={`Accept invitation to ${i.projectKey}`}
              onClick={() => answer.mutate({ projectId: i.projectId, accept: true })}
            >
              Accept
            </Button>
            <Button
              disabled={answer.isPending}
              aria-label={`Decline invitation to ${i.projectKey}`}
              onClick={() => answer.mutate({ projectId: i.projectId, accept: false })}
            >
              Decline
            </Button>
          </li>
        ))}
      </ul>
      <ErrorBox error={answer.error} />
    </Panel>
  );
}
