import { type FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import { useAddRepo, usePatchProject, useProject, useRemoveRepo } from '../api/queries/projects.ts';
import { ConcurrencyCapPanel } from '../components/ConcurrencyCapPanel.tsx';
import { ConvertPanel } from '../components/ConvertPanel.tsx';
import { DeployTargetsPanel } from '../components/DeployTargetsPanel.tsx';
import { MembersPanel } from '../components/MembersPanel.tsx';
import { MergePolicyPanel } from '../components/MergePolicyPanel.tsx';
import { FollowupDefaultsPanel, PhasesPanel } from '../components/PhasesPanel.tsx';
import { ProjectDangerZone } from '../components/ProjectDangerZone.tsx';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
  TextArea,
  TextInput,
  useToast,
} from '../components/ui.tsx';
import { WorkingBranchControl } from '../components/WorkingBranchControl.tsx';
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
  const toast = useToast();
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
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
  const me = useMe();
  const orgRole = me.data?.activeOrg?.role;
  const canConvert = orgRole === 'owner' || orgRole === 'admin';

  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setBranch(project.workingBranch);
    setArch(project.architecturalGlobs.join('\n'));
    setE2e(project.e2eGlobs.join('\n'));
  }, [project]);

  if (q.isPending)
    return (
      <div className="mx-auto max-w-3xl">
        <PageSkeleton label="Loading project settings" panels={3} />
      </div>
    );
  if (q.isError)
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Project settings" />
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  const { repos, members } = q.data;
  const activeRepos = repos.filter((r) => !r.removedAt);

  const save = (e: FormEvent) => {
    e.preventDefault();
    patch.mutate(
      {
        name: name.trim(),
        workingBranch: branch.trim(),
        ...(traits.usesRepos ? { architecturalGlobs: lines(arch) } : {}),
        ...(traits.hasTestStage ? { e2eGlobs: lines(e2e) } : {}),
      },
      { onSuccess: () => toast.success('Settings saved') },
    );
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
          toast.success('Repository added');
          setRepoName('');
          setRepoUrl('');
          setRepoBranch('');
        },
      },
    );
  };

  const sections = [
    { id: 'general', label: 'Basics' },
    { id: 'stage', label: 'Stage' },
    ...(traits.usesRepos || activeRepos.length > 0 ? [{ id: 'repos', label: 'Repos' }] : []),
    ...(project && traits.usesRepos
      ? [
          { id: 'phases', label: 'Phases and deploys' },
          { id: 'merge', label: 'Merging' },
        ]
      : []),
    { id: 'members', label: 'Team' },
    { id: 'danger', label: 'Archive' },
  ];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHeader
        title={`${project?.name ?? ''} settings`}
        back={{ to: `/p/${project?.key}/board`, label: 'Back to the board' }}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{project?.key}</span>
            {project?.status === 'archived' && <Badge tone="amber">Archived</Badge>}
            {project?.myRole !== 'owner' && <Badge>shared with you</Badge>}
          </span>
        }
      />
      <nav aria-label="Settings sections" className="scroll-fade-x -mt-2 flex gap-2 overflow-x-auto pb-1">
        {sections.map((x) => (
          <a
            key={x.id}
            href={`#${x.id}`}
            className="inline-flex h-8 shrink-0 items-center rounded-full border border-control bg-surface px-3 text-sm font-medium text-muted hover:bg-sunken hover:text-fg"
          >
            {x.label}
          </a>
        ))}
      </nav>
      {!traits.usesRepos && (
        <Callout tone="info">
          This is a {project?.workflowKey} project: it needs no repository, and results go to its vault
          folder. Convert it to a delivery project to add repositories.
        </Callout>
      )}
      <div id="general" className="scroll-mt-20">
        <Panel title="General">
          <form onSubmit={save} className="flex flex-col gap-4" aria-label="Project settings">
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
            <Button type="submit" variant="primary" className="self-start" loading={patch.isPending}>
              Save settings
            </Button>
          </form>
        </Panel>
      </div>
      {project && (
        <div id="stage" className="scroll-mt-20">
          <ConvertPanel project={project} repos={repos} canConvert={canConvert} />
        </div>
      )}
      {(traits.usesRepos || activeRepos.length > 0) && (
        <div id="repos" className="scroll-mt-20">
          <Panel title="Repositories">
            {!traits.usesRepos && (
              <p className="mb-3 text-sm text-muted">
                This workflow needs no repository. Existing ones are listed so you can remove them.
              </p>
            )}
            <ul className="mb-4 flex flex-col divide-y divide-line" data-testid="repos">
              {activeRepos.map((r) => (
                <li key={r.id} className="flex flex-col py-3 text-sm first:pt-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block text-base font-medium text-fg">{r.name}</span>
                      <span className="block font-mono text-xs break-all text-subtle">{r.remoteUrl}</span>
                    </span>
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      aria-label={`Remove repository ${r.name}`}
                      onClick={() => setRemoving({ id: r.id, name: r.name })}
                    >
                      Remove
                    </Button>
                  </div>
                  {traits.usesRepos && (
                    <WorkingBranchControl projectId={id} repo={r} isOwner={project?.myRole === 'owner'} />
                  )}
                </li>
              ))}
              {activeRepos.length === 0 && (
                <li className="text-sm text-subtle">No repositories yet. Add the first one below.</li>
              )}
            </ul>
            {traits.usesRepos && (
              <form
                onSubmit={add}
                noValidate
                aria-label="Add repository"
                className="grid gap-4 border-t border-line pt-4 sm:grid-cols-3"
              >
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
                <div className="sm:col-span-3">
                  <ErrorBox error={addRepo.error ?? removeRepo.error} />
                </div>
                <Button
                  type="submit"
                  variant="primary"
                  className="justify-self-start sm:col-span-3"
                  loading={addRepo.isPending}
                >
                  Add repository
                </Button>
              </form>
            )}
          </Panel>
        </div>
      )}
      {project && traits.usesRepos && (
        <div id="phases" className="flex scroll-mt-20 flex-col gap-5">
          <PhasesPanel projectId={id} />
          <DeployTargetsPanel projectId={id} />
          <FollowupDefaultsPanel projectId={id} />
        </div>
      )}
      {project && traits.usesRepos && (
        <div id="merge" className="scroll-mt-20">
          <MergePolicyPanel projectId={id} project={project} history={q.data.mergePolicyHistory ?? []} />
        </div>
      )}
      {project && (
        <div id="concurrency" className="scroll-mt-20">
          <ConcurrencyCapPanel projectId={id} project={project} />
        </div>
      )}
      <div id="members" className="scroll-mt-20">
        <MembersPanel projectId={id} members={members} isOwner={project?.myRole === 'owner'} />
      </div>
      <div id="danger" className="scroll-mt-20">
        {project && <ProjectDangerZone project={project} />}
      </div>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? 'repository'}?`}
        description="Agents stop using this repository for the project. Existing branches and history stay on the remote."
        confirmLabel="Remove repository"
        pending={removeRepo.isPending}
        onConfirm={() =>
          removing &&
          removeRepo.mutate(removing.id, {
            onSuccess: () => {
              toast.success(`${removing.name} removed`);
              setRemoving(null);
            },
            onError: () => setRemoving(null),
          })
        }
      />
    </div>
  );
}
