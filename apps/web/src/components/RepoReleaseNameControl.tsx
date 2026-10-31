import type { ProjectRepoDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useSetRepoReleaseName } from '../api/queries/forges.ts';
import { Button, ErrorBox, TextInput } from './ui.tsx';

/**
 * The name in the release tag message and the release title ("<name> 1.4.0"), for expert mode. Empty: the project name.
 * On a phone the soft keyboard opens for this field; it stays visible and Enter saves.
 */
export function RepoReleaseNameControl({
  projectId,
  repo,
  isOwner,
  projectName,
}: {
  projectId: string;
  repo: ProjectRepoDto;
  isOwner: boolean;
  projectName: string;
}) {
  const set = useSetRepoReleaseName(projectId);
  const saved = repo.releaseName ?? '';
  const [value, setValue] = useState(saved);
  const tooLong = value.trim().length > 100;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!tooLong) set.mutate({ repoId: repo.id, releaseName: value.trim() || null });
  };
  if (!isOwner)
    return (
      <p className="text-xs text-subtle" data-testid={`release-name-${repo.name}`}>
        Release name: {saved || projectName}
      </p>
    );
  return (
    <form onSubmit={submit} className="mt-2 flex flex-col gap-2" data-testid={`release-name-${repo.name}`}>
      <TextInput
        label="Release name"
        hint="Used in the tag message and the release title, for example Guildwise HQ 1.4.0."
        placeholder={projectName}
        value={value}
        error={tooLong ? 'Use at most 100 characters.' : undefined}
        autoCapitalize="words"
        enterKeyHint="done"
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        type="submit"
        size="sm"
        className="min-h-11 self-start sm:min-h-0"
        loading={set.isPending}
        disabled={tooLong || value.trim() === saved}
      >
        Save release name
      </Button>
      <ErrorBox error={set.error} />
    </form>
  );
}
