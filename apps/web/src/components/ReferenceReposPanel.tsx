import type { ProjectDetailResponse, ReferenceRepoDto } from '@aom/shared';
import { useState } from 'react';
import { useSetReferenceRepos } from '../api/queries/projects.ts';
import { Button, ErrorBox, Panel, Select } from './ui.tsx';

/**
 * "Reference repositories": other repositories on the workstation that this project's agents may read, read-only, in
 * card work and in chats. Nothing else outside the card's own folder is opened (not the other projects, not .env files
 * or keys inside the repositories you pick, not this platform's own code unless you pick it). Only the project owner
 * changes the list; the choices are repositories of the organization's other projects the owner belongs to.
 */
export function ReferenceReposPanel({
  projectId,
  referenceRepos,
  candidates,
  isOwner,
}: {
  projectId: string;
  referenceRepos: ProjectDetailResponse['referenceRepos'];
  candidates: ProjectDetailResponse['referenceRepoCandidates'];
  isOwner: boolean;
}) {
  const set = useSetReferenceRepos(projectId);
  const [pick, setPick] = useState('');
  const chosen = new Set(referenceRepos.map((r) => r.repoId));
  const available = candidates.filter((c) => !chosen.has(c.repoId));
  const label = (r: ReferenceRepoDto) => `${r.projectName} / ${r.name}`;
  const save = (ids: string[], onSuccess?: () => void) => set.mutate(ids, onSuccess ? { onSuccess } : {});

  return (
    <Panel>
      <h2 className="mb-3 text-lg font-semibold text-fg">Reference repositories</h2>
      <p className="text-sm text-muted">
        Other repositories this project's agents may read, in card work and in chats. They get them read-only
        on the workstations that have them cloned: they cannot change them, and secret files inside (.env,
        keys, certificates) stay blocked. Every repository you do not pick here stays blocked.
      </p>
      {referenceRepos.length === 0 ? (
        <p className="mt-3 text-sm text-subtle" data-testid="reference-repos-empty">
          No reference repositories.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1" data-testid="reference-repos">
          {referenceRepos.map((r) => (
            <li key={r.repoId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{label(r)}</span>
              <span className="font-mono text-xs text-subtle">{r.remoteUrl}</span>
              {isOwner && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={set.isPending}
                  aria-label={`Remove ${label(r)}`}
                  onClick={() =>
                    save(referenceRepos.filter((x) => x.repoId !== r.repoId).map((x) => x.repoId))
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {isOwner &&
        (available.length === 0 ? (
          <p className="mt-3 text-xs text-subtle" data-testid="reference-repos-none-left">
            {candidates.length === 0
              ? 'No other repositories to pick: add repositories to your other projects first.'
              : 'Every repository of your other projects is already a reference repository.'}
          </p>
        ) : (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!pick) return;
              save([...referenceRepos.map((r) => r.repoId), pick], () => setPick(''));
            }}
          >
            <Select label="Add a reference repository" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a repository...</option>
              {available.map((c) => (
                <option key={c.repoId} value={c.repoId}>
                  {label(c)}
                </option>
              ))}
            </Select>
            <Button type="submit" size="sm" variant="primary" disabled={!pick} loading={set.isPending}>
              Add
            </Button>
          </form>
        ))}
      <ErrorBox error={set.error} />
    </Panel>
  );
}
