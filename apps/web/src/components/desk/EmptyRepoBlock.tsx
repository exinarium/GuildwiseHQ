import { useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import { useCreateInitialCommit } from '../../api/queries/projects.ts';
import { Button, useToast } from '../ui.tsx';

/**
 * uat-runner-fixes-3 finding 5: a project repository with no commit yet. One click asks the workstation that found it to
 * make the first (empty) commit on the working branch and push it; the cards start by themselves afterwards.
 */
export function EmptyRepoBlock({ data }: { data: Record<string, unknown> }) {
  const create = useCreateInitialCommit();
  const toast = useToast();
  const [asked, setAsked] = useState(false);
  const str = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : '');
  const branch = str('branch') || 'main';
  const ids = { projectId: str('projectId'), repoId: str('repoId'), workstationId: str('workstationId') };
  if (!ids.projectId || !ids.repoId || !ids.workstationId) return null;
  return (
    <div className="mt-3 flex flex-col items-start gap-2" data-testid="desk-empty-repo">
      <Button
        variant="primary"
        loading={create.isPending}
        disabled={asked}
        data-testid="desk-empty-repo-create"
        onClick={() =>
          create.mutate(ids, {
            onSuccess: () => {
              setAsked(true);
              toast.success(`The workstation is making the first commit on ${branch}.`);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      >
        Create the first commit on {branch}
      </Button>
      {asked && (
        <p className="text-sm text-muted" role="status">
          Asked. This item closes when the commit is on the repository.
        </p>
      )}
    </div>
  );
}
