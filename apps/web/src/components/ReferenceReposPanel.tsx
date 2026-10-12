import type { ProjectDetailResponse, ReferenceRepoDto, WorkstationRepoDto } from '@aom/shared';
import { useState } from 'react';
import { useSetReferenceRepos } from '../api/queries/projects.ts';
import { Button, ErrorBox, Panel, Select } from './ui.tsx';

/**
 * "Reference repositories": other repositories on the workstation that this project's agents may read, read-only, in
 * card work and in chats. Nothing else outside the card's own folder is opened (not the other projects, not .env files
 * or keys inside the repositories you pick, not this platform's own code unless you pick it). Only the project owner
 * changes the list. The choices are the repositories of the organization's other projects (all of them for the
 * organization's owners and admins, else the projects you belong to) and any repository cloned on one of your
 * workstations, listed under that workstation.
 */
export function ReferenceReposPanel({
  projectId,
  referenceRepos,
  candidates,
  workstationRepos = [],
  workstationCandidates = [],
  isOwner,
}: {
  projectId: string;
  referenceRepos: ProjectDetailResponse['referenceRepos'];
  candidates: ProjectDetailResponse['referenceRepoCandidates'];
  workstationRepos?: ProjectDetailResponse['referenceWorkstationRepos'];
  workstationCandidates?: ProjectDetailResponse['workstationRepoCandidates'];
  isOwner: boolean;
}) {
  const set = useSetReferenceRepos(projectId);
  const [pick, setPick] = useState('');
  const chosen = new Set(referenceRepos.map((r) => r.repoId));
  const wsKey = (r: Pick<WorkstationRepoDto, 'workstationId' | 'localKey'>) =>
    `w:${r.workstationId}:${r.localKey}`;
  const chosenWs = new Set(workstationRepos.map(wsKey));
  const available = candidates.filter((c) => !chosen.has(c.repoId));
  const availableWs = workstationCandidates.filter((c) => !chosenWs.has(wsKey(c)));
  const label = (r: ReferenceRepoDto) => `${r.projectName} / ${r.name}`;
  const wsLabel = (r: WorkstationRepoDto) => `${r.workstationName} / ${r.localKey}`;
  const ids = (list: ReferenceRepoDto[]) => list.map((r) => r.repoId);
  const wsRefs = (list: WorkstationRepoDto[]) =>
    list.map((r) => ({ workstationId: r.workstationId, localKey: r.localKey }));
  const save = (
    next: { repoIds: string[]; workstationRepos: Array<{ workstationId: string; localKey: string }> },
    onSuccess?: () => void,
  ) => set.mutate(next, onSuccess ? { onSuccess } : {});
  const nothingChosen = referenceRepos.length === 0 && workstationRepos.length === 0;
  const nothingLeft = available.length === 0 && availableWs.length === 0;
  const groups = new Map<string, WorkstationRepoDto[]>();
  for (const c of availableWs) groups.set(c.workstationName, [...(groups.get(c.workstationName) ?? []), c]);

  return (
    <Panel>
      <h2 className="mb-3 text-lg font-semibold text-fg">Reference repositories</h2>
      <p className="text-sm text-muted">
        Other repositories this project's agents may read, in card work and in chats. They get them read-only
        on the workstations that have them cloned: they cannot change them, and secret files inside (.env,
        keys, certificates) stay blocked. Every repository you do not pick here stays blocked. You can pick
        the repositories of the organization's projects, or any repository cloned on one of your workstations.
      </p>
      {nothingChosen ? (
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
                    save({
                      repoIds: ids(referenceRepos.filter((x) => x.repoId !== r.repoId)),
                      workstationRepos: wsRefs(workstationRepos),
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
          {workstationRepos.map((r) => (
            <li key={wsKey(r)} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{wsLabel(r)}</span>
              <span className="font-mono text-xs text-subtle">{r.remoteUrl ?? 'no remote'}</span>
              {isOwner && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={set.isPending}
                  aria-label={`Remove ${wsLabel(r)}`}
                  onClick={() =>
                    save({
                      repoIds: ids(referenceRepos),
                      workstationRepos: wsRefs(workstationRepos.filter((x) => wsKey(x) !== wsKey(r))),
                    })
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
        (nothingLeft ? (
          <p className="mt-3 text-xs text-subtle" data-testid="reference-repos-none-left">
            {candidates.length === 0 && workstationCandidates.length === 0
              ? 'No other repositories to pick: add repositories to your other projects, or clone one on a connected workstation.'
              : 'Every repository you can pick is already a reference repository.'}
          </p>
        ) : (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!pick) return;
              const next = pick.startsWith('w:')
                ? {
                    repoIds: ids(referenceRepos),
                    workstationRepos: [
                      ...wsRefs(workstationRepos),
                      ...wsRefs(availableWs.filter((c) => wsKey(c) === pick)),
                    ],
                  }
                : { repoIds: [...ids(referenceRepos), pick], workstationRepos: wsRefs(workstationRepos) };
              save(next, () => setPick(''));
            }}
          >
            <Select label="Add a reference repository" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a repository...</option>
              {available.length > 0 && (
                <optgroup label="Projects">
                  {available.map((c) => (
                    <option key={c.repoId} value={c.repoId}>
                      {label(c)}
                    </option>
                  ))}
                </optgroup>
              )}
              {[...groups.entries()].map(([name, list]) => (
                <optgroup key={name} label={`On ${name}`}>
                  {list.map((c) => (
                    <option key={wsKey(c)} value={wsKey(c)}>
                      {c.localKey}
                      {c.remoteUrl ? '' : ' (no remote)'}
                    </option>
                  ))}
                </optgroup>
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
