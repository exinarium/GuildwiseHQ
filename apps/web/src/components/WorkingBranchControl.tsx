import type { ProjectRepoDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { useRequestReleasePr, useSetRepoMainBranch } from '../api/queries/forges.ts';
import { useSetWorkingBranch } from '../api/queries/projects.ts';
import { formatDate } from '../lib/time.ts';
import { Badge, Button, ErrorBox, Select, TextInput } from './ui.tsx';

const OTHER = '__other__';

/** One sentence each: the two branches every repository has. Shown in the settings and reused by the docs. */
export const MAIN_BRANCH_EXPLAINER = 'Where pull requests go. Empty means the repository’s default branch.';
export const WORKING_BRANCH_EXPLAINER =
  'Where finished card work is combined. It can be the same branch as the main branch; if it does not exist it is created from the main branch and pushed.';

/**
 * The two branches of one repository in the project settings. The **main branch** is where pull requests go (default:
 * the repository's default branch); the **working branch** is where card work is integrated (it may be the same
 * branch). The working branch shows whether it exists or when it was created, the main branch can be named by the
 * owner, and the owner can open a pull request from the working branch to the main branch.
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
  const known = repo.knownBranches ?? [];
  const mainName = repo.mainBranch ?? null;
  const created = repo.workingBranchCreated ?? null;
  // Only a list of known age can say a branch was not seen; an undated one proves nothing.
  const missing =
    !!repo.workingBranch &&
    !created &&
    known.length > 0 &&
    !!repo.knownBranchesAt &&
    !known.includes(repo.workingBranch);
  const sameBranch = !!repo.workingBranch && mainName === repo.workingBranch;
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid={`branches-${repo.name}`}>
      <MainBranchRow projectId={projectId} repo={repo} isOwner={isOwner} />
      <WorkingBranchRow projectId={projectId} repo={repo} isOwner={isOwner} />
      {created && (
        <p className="text-xs text-subtle" data-testid={`working-branch-created-${repo.name}`}>
          The working branch did not exist: it was created from {created.from}
          {created.pushed ? ' and pushed' : ''} on {formatDate(created.at)}.
        </p>
      )}
      {missing && (
        <p className="text-xs text-subtle" data-testid={`working-branch-missing-${repo.name}`}>
          The working branch {repo.workingBranch} has not been seen in the repository yet (branch list of{' '}
          {formatDate(repo.knownBranchesAt as string)}). If it is not there, it is created from{' '}
          {mainName ?? 'the main branch'} and pushed when the first card starts.
        </p>
      )}
      {sameBranch && (
        <p className="text-xs text-subtle">
          The working branch is the main branch: pull requests from cards go straight into it.
        </p>
      )}
      {isOwner && repo.workingBranch && !sameBranch && <ReleasePr projectId={projectId} repo={repo} />}
    </div>
  );
}

function MainBranchRow({
  projectId,
  repo,
  isOwner,
}: {
  projectId: string;
  repo: ProjectRepoDto;
  isOwner: boolean;
}) {
  const set = useSetRepoMainBranch(projectId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(repo.mainBranch ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    set.mutate({ repoId: repo.id, mainBranch: value.trim() || null }, { onSuccess: () => setEditing(false) });
  };
  return (
    <div className="flex flex-col gap-1" data-testid={`main-branch-${repo.name}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg">Main branch</span>
        {repo.mainBranch ? (
          <Badge tone="blue">{repo.mainBranch}</Badge>
        ) : (
          <Badge title="The repository's default branch">repository default</Badge>
        )}
        {isOwner && !editing && (
          <Button
            variant="ghost"
            aria-label={`Change main branch of ${repo.name}`}
            onClick={() => setEditing(true)}
          >
            Change
          </Button>
        )}
      </div>
      <p className="text-xs text-subtle">{MAIN_BRANCH_EXPLAINER}</p>
      {!repo.mainBranch && (
        <p role="note" className="text-xs text-amber-700">
          Main branch not set: the runner uses the host's default (its name is not known here). Set it if your
          main branch is not the host's default.
        </p>
      )}
      {editing && (
        <form
          onSubmit={submit}
          noValidate
          aria-label={`Main branch of ${repo.name}`}
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
        >
          <div className="w-full sm:w-56">
            <TextInput
              label="Branch name"
              hint="Leave empty for the repository's default branch."
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <Button type="submit" variant="primary" disabled={set.isPending}>
            Save main branch
          </Button>
          <Button onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      )}
      <ErrorBox error={set.error} />
    </div>
  );
}

function WorkingBranchRow({
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
    <div className="flex flex-col gap-1" data-testid={`working-branch-${repo.name}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg">Working branch</span>
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
      <p className="text-xs text-subtle">{WORKING_BRANCH_EXPLAINER}</p>
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
                hint="If it does not exist, it is created from the main branch and pushed when the first card starts."
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

/** "Open a pull request from the working branch to the main branch": the workstation opens it through the git host. */
function ReleasePr({ projectId, repo }: { projectId: string; repo: ProjectRepoDto }) {
  const request = useRequestReleasePr(projectId);
  const last = repo.releasePr ?? null;
  const target = repo.mainBranch ?? 'the main branch';
  return (
    <div className="flex flex-col gap-1" data-testid={`release-pr-${repo.name}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button
          size="sm"
          loading={request.isPending || last?.state === 'pending'}
          onClick={() => request.mutate(repo.id)}
        >
          Open pull request: {repo.workingBranch} to {target}
        </Button>
        {last?.state === 'opened' && last.url && (
          <a href={last.url} target="_blank" rel="noreferrer" className="text-xs underline">
            View the pull request
          </a>
        )}
      </div>
      {last && last.state !== 'pending' && (last.message || last.state === 'opened') && (
        <p
          className={`text-xs ${last.state === 'failed' ? 'text-danger-soft-fg' : 'text-subtle'}`}
          data-testid={`release-pr-result-${repo.name}`}
        >
          {last.state === 'opened' && !last.message ? 'The pull request was opened.' : last.message}
        </p>
      )}
      <ErrorBox error={request.error} />
    </div>
  );
}
