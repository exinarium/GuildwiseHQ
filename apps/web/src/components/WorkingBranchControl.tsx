import type { ProjectRepoDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { useSetWorkingBranch } from '../api/queries/projects.ts';
import { Badge, Button, ErrorBox, Select, TextInput } from './ui.tsx';

const OTHER = '__other__';

/**
 * The working branch of one repository in the project settings: the confirmed branch with a "Change" action, or a
 * notice that none is confirmed (hygiene then commits and pushes nothing there) with a link to the desk question.
 * Only the project owner changes it.
 */
export function WorkingBranchControl({
  projectId,
  repo,
  isOwner,
}: {
  projectId: string;
  repo: ProjectRepoDto;
  isOwner: boolean;
}) {
  const set = useSetWorkingBranch(projectId);
  const [editing, setEditing] = useState(false);
  const known = repo.knownBranches ?? [];
  const [pick, setPick] = useState<string>(repo.workingBranch ?? known[0] ?? OTHER);
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState('');
  const options = [...new Set([...(repo.workingBranch ? [repo.workingBranch] : []), ...known])];

  const save = (e: FormEvent) => {
    e.preventDefault();
    const branch = (pick === OTHER ? typed : pick).trim();
    if (!branch) return setErr('Type the name of the branch');
    setErr('');
    set.mutate(
      { repoId: repo.id, branch },
      {
        onSuccess: () => {
          setEditing(false);
          setTyped('');
        },
      },
    );
  };

  return (
    <div className="mt-1 flex flex-col gap-1" data-testid={`working-branch-${repo.name}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">Working branch</span>
        {repo.workingBranch ? (
          <Badge tone="green">{repo.workingBranch}</Badge>
        ) : (
          <Badge
            tone="amber"
            title="Hygiene never commits or pushes to a repository without a confirmed branch"
          >
            not confirmed
          </Badge>
        )}
        {!repo.workingBranch && repo.branchQuestionId && (
          <Link to={`/desk#desk-item-${repo.branchQuestionId}`} className="text-xs underline">
            Answer on the desk
          </Link>
        )}
        {isOwner && !editing && (
          <Button
            variant="ghost"
            aria-label={`${repo.workingBranch ? 'Change' : 'Set'} working branch of ${repo.name}`}
            onClick={() => setEditing(true)}
          >
            {repo.workingBranch ? 'Change' : 'Set'}
          </Button>
        )}
      </div>
      {editing && (
        <form
          onSubmit={save}
          noValidate
          aria-label={`Working branch of ${repo.name}`}
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
        >
          <div className="w-full sm:w-56">
            <Select label="Branch" value={pick} onChange={(e) => setPick(e.target.value)}>
              {options.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
              <option value={OTHER}>Another branch…</option>
            </Select>
          </div>
          {pick === OTHER && (
            <div className="w-full sm:w-56">
              <TextInput
                label="Branch name"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                error={err}
              />
            </div>
          )}
          <Button type="submit" variant="primary" disabled={set.isPending}>
            Save branch
          </Button>
          <Button onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      )}
      <ErrorBox error={set.error} />
    </div>
  );
}
