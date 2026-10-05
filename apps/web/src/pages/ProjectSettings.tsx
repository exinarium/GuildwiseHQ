import { type FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAddRepo, usePatchProject, useProject, useRemoveRepo } from '../api/queries/projects.ts';
import { MembersPanel } from '../components/MembersPanel.tsx';
import { MergePolicyPanel } from '../components/MergePolicyPanel.tsx';
import {
  Badge,
  Button,
  ErrorBox,
  PageHeader,
  Panel,
  Spinner,
  TextArea,
  TextInput,
} from '../components/ui.tsx';
import { useProjectWorkflowTraits } from '../lib/projectWorkflow.ts';

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

export function ProjectSettings() {
  const { id = '' } = useParams();
  const q = useProject(id);
  const patch = usePatchProject(id);
  const addRepo = useAddRepo(id);
  const removeRepo = useRemoveRepo(id);
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('');
  const [arch, setArch] = useState('');
  const [e2e, setE2e] = useState('');
  const [repoName, setRepoName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [repoBranch, setRepoBranch] = useState('');
  const [repoErr, setRepoErr] = useState<Record<string, string>>({});
  const project = q.data?.project;
  const traits = useProjectWorkflowTraits(project?.id, project?.workflowKey);

  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setBranch(project.workingBranch);
    setArch(project.architecturalGlobs.join('\n'));
    setE2e(project.e2eGlobs.join('\n'));
  }, [project]);

  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorBox error={q.error} />;
  const { repos, members } = q.data;
  const activeRepos = repos.filter((r) => !r.removedAt);

  const save = (e: FormEvent) => {
    e.preventDefault();
    patch.mutate({
      name: name.trim(),
      workingBranch: branch.trim(),
      ...(traits.usesRepos ? { architecturalGlobs: lines(arch) } : {}),
      ...(traits.hasTestStage ? { e2eGlobs: lines(e2e) } : {}),
    });
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!repoName.trim()) errs.name = 'Repository name is required';
    if (!repoUrl.trim()) errs.url = 'Remote URL is required';
    setRepoErr(errs);
    if (Object.keys(errs).length) return;
    addRepo.mutate(
      {
        name: repoName.trim(),
        remoteUrl: repoUrl.trim(),
        ...(repoBranch.trim() ? { workingBranch: repoBranch.trim() } : {}),
      },
      {
        onSuccess: () => {
          setRepoName('');
          setRepoUrl('');
          setRepoBranch('');
        },
      },
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <PageHeader
        title={`${project?.key} settings`}
        actions={
          <Link to={`/p/${project?.key}/board`} className="text-sm underline">
            Back to board
          </Link>
        }
      />
      <Panel>
        <h2 className="mb-2 text-sm font-semibold">General</h2>
        <form onSubmit={save} className="flex flex-col gap-3" aria-label="Project settings">
          <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput label="Working branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
          {traits.usesRepos && (
            <TextArea
              label="Architectural globs"
              hint="One glob per line. Large diffs touching these are risk tier large."
              value={arch}
              onChange={(e) => setArch(e.target.value)}
            />
          )}
          {traits.hasTestStage && (
            <TextArea
              label="E2E globs"
              hint="One glob per line"
              value={e2e}
              onChange={(e) => setE2e(e.target.value)}
            />
          )}
          <ErrorBox error={patch.error} />
          <Button type="submit" variant="primary" className="self-start" disabled={patch.isPending}>
            Save settings
          </Button>
          {patch.isSuccess && (
            <p role="status" className="text-sm text-emerald-600">
              Saved.
            </p>
          )}
        </form>
      </Panel>
      {(traits.usesRepos || activeRepos.length > 0) && (
        <Panel>
          <h2 className="mb-2 text-sm font-semibold">Repositories</h2>
          {!traits.usesRepos && (
            <p className="mb-2 text-sm text-zinc-500">
              This workflow needs no repository. Existing ones are listed so you can remove them.
            </p>
          )}
          <ul className="mb-3 flex flex-col gap-1.5" data-testid="repos">
            {activeRepos.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-medium">{r.name}</span>{' '}
                  <span className="font-mono text-xs text-zinc-500 break-all">{r.remoteUrl}</span>{' '}
                  {r.workingBranch && <Badge>{r.workingBranch}</Badge>}
                </span>
                <Button
                  variant="ghost"
                  aria-label={`Remove repository ${r.name}`}
                  onClick={() => removeRepo.mutate(r.id)}
                >
                  Remove
                </Button>
              </li>
            ))}
            {activeRepos.length === 0 && <li className="text-sm text-zinc-500">No repositories yet.</li>}
          </ul>
          {traits.usesRepos && (
            <form onSubmit={add} noValidate aria-label="Add repository" className="grid gap-3 sm:grid-cols-3">
              <TextInput
                label="Repository name"
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                error={repoErr.name}
              />
              <TextInput
                label="Remote URL"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                error={repoErr.url}
              />
              <TextInput
                label="Branch (optional)"
                value={repoBranch}
                onChange={(e) => setRepoBranch(e.target.value)}
              />
              <ErrorBox error={addRepo.error ?? removeRepo.error} />
              <Button
                type="submit"
                variant="primary"
                className="self-start sm:col-span-3"
                disabled={addRepo.isPending}
              >
                Add repository
              </Button>
            </form>
          )}
        </Panel>
      )}
      {project && traits.usesRepos && (
        <MergePolicyPanel projectId={id} project={project} history={q.data.mergePolicyHistory ?? []} />
      )}
      <MembersPanel projectId={id} members={members} isOwner={project?.myRole === 'owner'} />
    </div>
  );
}
