import { isSafeProjectPath, type ProjectRepoDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useSetRepoProjectPath } from '../api/queries/forges.ts';
import { Button, ErrorBox, TextInput } from './ui.tsx';

/**
 * The folder of the repository the project lives in (a monorepo, `src/app`). The development environment check and the
 * dependency installs run from there, and card agents are told to build and test there. Empty: the repository root.
 */
export function RepoProjectPathControl({
  projectId,
  repo,
  isOwner,
}: {
  projectId: string;
  repo: ProjectRepoDto;
  isOwner: boolean;
}) {
  const set = useSetRepoProjectPath(projectId);
  const [edit, setEdit] = useState(false);
  const [value, setValue] = useState(repo.projectPath ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!isSafeProjectPath(value)) {
      setError('Use a folder inside the repository, like src/app (no "..", no leading "/").');
      return;
    }
    setError(null);
    set.mutate({ repoId: repo.id, projectPath: value.trim() || null }, { onSuccess: () => setEdit(false) });
  };

  return (
    <div className="mt-2 text-sm" data-testid={`repo-path-${repo.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-subtle">Project path</span>
        <span className="font-mono text-xs">{repo.projectPath ?? 'repository root'}</span>
        {isOwner && (
          <Button size="sm" variant="ghost" onClick={() => setEdit(!edit)}>
            {edit ? 'Cancel' : 'Change'}
          </Button>
        )}
      </div>
      {edit && isOwner && (
        <form onSubmit={submit} noValidate className="mt-2 flex flex-wrap items-end gap-2">
          <TextInput
            label={`Project path in ${repo.name}`}
            hint="The folder the app lives in, like src/app. Leave empty for the repository root. Check the environment again afterwards."
            value={value}
            onChange={(e) => setValue(e.target.value)}
            error={error ?? undefined}
          />
          <Button type="submit" size="sm" variant="primary" loading={set.isPending}>
            Save path
          </Button>
        </form>
      )}
      <ErrorBox error={set.error} />
    </div>
  );
}
