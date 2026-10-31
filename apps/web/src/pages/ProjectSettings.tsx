import { COMPLETION_ACTION_LABELS, isSafePrBranchPrefix } from '@aom/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Navigate, useLocation, useParams } from 'react-router';
import { usePatchProject, useProject, useProjects, useRemoveRepo } from '../api/queries/projects.ts';
import { AddRepoForm } from '../components/AddRepoForm.tsx';
import { ArchitectPanel } from '../components/ArchitectPanel.tsx';
import { BudgetBanner } from '../components/BudgetBanner.tsx';
import { BudgetPanel } from '../components/BudgetPanel.tsx';
import { ClaudeAccountPanel } from '../components/ClaudeAccountPanel.tsx';
import { CommitAsPanel } from '../components/CommitAsPanel.tsx';
import { ConcurrencyCapPanel } from '../components/ConcurrencyCapPanel.tsx';
import { ConvertPanel } from '../components/ConvertPanel.tsx';
import { EnvironmentsPointer } from '../components/environments/Pointer.tsx';
import { FullSuitePanel } from '../components/FullSuitePanel.tsx';
import { GraphStatusPanel } from '../components/GraphStatusPanel.tsx';
import { ManualQaPanel } from '../components/ManualQaPanel.tsx';
import { McpServersPanel } from '../components/McpServersPanel.tsx';
import { MembersPanel } from '../components/MembersPanel.tsx';
import { MergePolicyPanel } from '../components/MergePolicyPanel.tsx';
import { OwnerApprovalPanel } from '../components/OwnerApprovalPanel.tsx';
import { PhasesPanel } from '../components/PhasesPanel.tsx';
import { ProjectDangerZone } from '../components/ProjectDangerZone.tsx';
import { ProjectPolicyPanel } from '../components/ProjectPolicyPanel.tsx';
import { ProjectWorkflows } from '../components/ProjectWorkflows.tsx';
import { ProviderAccountPanel } from '../components/ProviderAccountPanel.tsx';
import { ReferenceReposPanel } from '../components/ReferenceReposPanel.tsx';
import { RepoAccessControl } from '../components/RepoAccessControl.tsx';
import { RepoComponentRulesControl } from '../components/RepoComponentRulesControl.tsx';
import { RepoReleaseNameControl } from '../components/RepoReleaseNameControl.tsx';
import { RepoProjectPathControl } from '../components/RepoProjectPathControl.tsx';
import { RepoProviderControl } from '../components/RepoProviderControl.tsx';
import { EnvironmentPanel, RepoSetupStatus } from '../components/RepoSetupStatus.tsx';
import { RepoSyncLine } from '../components/RepoSync.tsx';
import { Reword } from '../components/Reword.tsx';
import { TestServicesPanel } from '../components/TestServicesPanel.tsx';
import { UsageLimitBanner } from '../components/UsageLimitBanner.tsx';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
  Select,
  TextArea,
  TextInput,
  useToast,
} from '../components/ui.tsx';
import { WorkingBranchControl } from '../components/WorkingBranchControl.tsx';
import { useExpertMode } from '../lib/expert-mode.ts';
import { money } from '../lib/money.ts';
import { useBusinessMode } from '../lib/orgMode.ts';
import { useCanConvert, useProjectWorkflowTraits } from '../lib/projectWorkflow.ts';

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

export function ProjectSettings() {
  const { id = '' } = useParams();
  const q = useProject(id);
  const patch = usePatchProject(id);
  const removeRepo = useRemoveRepo(id);
  const toast = useToast();
  const expert = useExpertMode();
  const [landing, setLanding] = useState<'merge' | 'pr'>('merge');
  const [removeBranches, setRemoveBranches] = useState(true);
  const [prPrefix, setPrPrefix] = useState('');
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('');
  const [arch, setArch] = useState('');
  const [e2e, setE2e] = useState('');
  const project = q.data?.project;
  const { hash } = useLocation();
  const projectList = useProjects();
  const projectKey = projectList.data?.find((p) => p.id === id)?.key ?? project?.key;
  const traits = useProjectWorkflowTraits(project?.id, project?.workflowKey);
  const business = useBusinessMode();
  // The repository, branch, environment and merge sections: none of them in a Business mode organization.
  const repoUi = traits.usesRepos && !business;
  const canConvert = useCanConvert(project);

  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setBranch(project.workingBranch);
    setLanding(project.defaultCompletion ?? 'merge');
    setRemoveBranches(project.removeFinishedBranches ?? true);
    setPrPrefix(project.prBranchPrefix ?? '');
    setArch(project.architecturalGlobs.join('\n'));
    setE2e(project.e2eGlobs.join('\n'));
  }, [project]);

  // the old anchors moved: the start steps and the deploy setup live on the Environments page now
  if (projectKey && (hash === '#run' || hash === '#phases'))
    return (
      <Navigate
        to={`/p/${projectKey}/environments#${hash === '#run' ? 'start-steps' : 'environments'}`}
        replace
      />
    );
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

  const prPrefixOk = isSafePrBranchPrefix(prPrefix.trim());
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (repoUi && !prPrefixOk) return;
    patch.mutate(
      {
        name: name.trim(),
        ...(expert && !business ? { workingBranch: branch.trim() } : {}),
        ...(repoUi
          ? {
              defaultCompletion: landing,
              removeFinishedBranches: removeBranches,
              prBranchPrefix: prPrefix.trim(),
            }
          : {}),
        ...(repoUi ? { architecturalGlobs: lines(arch) } : {}),
        ...(traits.hasTestStage ? { e2eGlobs: lines(e2e) } : {}),
      },
      { onSuccess: () => toast.success('Settings saved') },
    );
  };
  const sections = [
    { id: 'general', label: 'Basics' },
    { id: 'stage', label: 'Stage' },
    ...(project && traits.usesRepos ? [{ id: 'workflows', label: 'Workflows' }] : []),
    ...(repoUi || (!business && activeRepos.length > 0) ? [{ id: 'repos', label: 'Repos' }] : []),
    ...(project && repoUi
      ? [
          { id: 'phase-list', label: 'Phases' },
          { id: 'environments', label: 'Environments' },
          { id: 'reference-repos', label: 'Reference repos' },
          { id: 'merge', label: 'Merging' },
        ]
      : []),
    { id: 'budget', label: 'Budget' },
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
            {project?.budget?.spentMicros !== null && project?.budget?.spentMicros !== undefined && (
              <span className="tnum text-muted" data-testid="settings-spend">
                {money(project.budget.spentMicros, project.budget.currency)}
                {project.budget.monthlyMicros !== null &&
                  ` of ${money(project.budget.monthlyMicros, project.budget.currency)}`}{' '}
                this month
              </span>
            )}
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
      {project && <UsageLimitBanner limit={project.usageLimit} />}
      {project && (
        <BudgetBanner
          budget={project.budget}
          projectId={id}
          name={project.key}
          settingsTo={`/projects/${id}/settings#budget`}
        />
      )}
      {!traits.usesRepos && !business && (
        <Callout tone="info">
          <Reword>{`This is a ${project?.workflowKey} project: it needs no repository, and results go to its vault folder. Convert it to a delivery project to add repositories.`}</Reword>
        </Callout>
      )}
      <div id="general" className="scroll-mt-20">
        <Panel title="General">
          <form onSubmit={save} className="flex flex-col gap-4" aria-label="Project settings">
            <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            {expert && !business && (
              <TextInput
                label="Working branch"
                hint="The project's default working branch. Each repository can have its own below; a branch that does not exist is created from the main branch."
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            )}
            {repoUi && (
              <Select
                label="How finished work lands"
                data-testid="default-completion"
                hint={
                  expert
                    ? 'The default completion action of new cards (a card can override it). A protected working branch switches this to a pull request on its own. Pull requests from the working branch to the main branch are opened from the repository below.'
                    : 'Applies to every card in this project. If the working branch is protected, Guildwise switches to pull requests by itself.'
                }
                value={landing}
                onChange={(e) => setLanding(e.target.value as 'merge' | 'pr')}
              >
                <option value="merge">{COMPLETION_ACTION_LABELS.merge.label} (no pull request)</option>
                <option value="pr">Pull request I approve</option>
              </Select>
            )}
            {repoUi && (
              <TextInput
                label="Pull request branch prefix"
                data-testid="pr-branch-prefix"
                hint="Pull requests go to the git host as <prefix>/<ticket>, for example pieter/DCPL-4276. Empty: feature."
                placeholder="feature"
                value={prPrefix}
                error={prPrefixOk ? undefined : 'Letters, digits, . _ - and /, at most 40 characters.'}
                onChange={(e) => setPrPrefix(e.target.value)}
              />
            )}
            {repoUi && (
              <label className="flex items-start gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={removeBranches}
                  data-testid="remove-finished-branches"
                  onChange={(e) => setRemoveBranches(e.target.checked)}
                />
                <span>
                  Remove finished card branches
                  <span className="block text-xs text-subtle">
                    Repository hygiene deletes the branch of a done or cancelled card, on the git host and on
                    the workstation, once its work is in the working branch or its pull request is closed.
                    Branches with work found nowhere else, and open pull requests, are never touched.
                  </span>
                </span>
              </label>
            )}
            {repoUi && (
              <TextArea
                label="Architectural globs"
                hint="One glob per line. Large diffs touching these are risk tier large."
                value={arch}
                onChange={(e) => setArch(e.target.value)}
              />
            )}
            {traits.hasTestStage && !business && (
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
      {project && traits.usesRepos && (
        <div id="workflows" className="scroll-mt-20">
          <ProjectWorkflows projectId={id} projectKey={project.key} />
        </div>
      )}
      {(repoUi || (!business && activeRepos.length > 0)) && (
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
                    <RepoProviderControl projectId={id} repo={r} isOwner={project?.myRole === 'owner'} />
                  )}
                  {traits.usesRepos && (
                    <RepoAccessControl projectId={id} repo={r} isOwner={project?.myRole === 'owner'} />
                  )}
                  {traits.usesRepos && (
                    <RepoProjectPathControl projectId={id} repo={r} isOwner={project?.myRole === 'owner'} />
                  )}
                  {traits.usesRepos && (
                    <RepoSetupStatus projectId={id} repo={r} canRetry={project?.myRole === 'owner'} />
                  )}
                  {traits.usesRepos && (
                    <WorkingBranchControl projectId={id} repo={r} isOwner={project?.myRole === 'owner'} />
                  )}
                  {traits.usesRepos && expert && (
                    <RepoComponentRulesControl
                      projectId={id}
                      repo={r}
                      isOwner={project?.myRole === 'owner'}
                    />
                  )}
                  {traits.usesRepos && expert && (
                    <RepoReleaseNameControl
                      projectId={id}
                      repo={r}
                      isOwner={project?.myRole === 'owner'}
                      projectName={project?.name ?? ''}
                    />
                  )}
                  {traits.usesRepos &&
                    (r.syncs ?? []).map((sy) => (
                      <RepoSyncLine
                        key={sy.workstationId}
                        sync={sy}
                        workstationId={sy.workstationId}
                        repoId={r.id}
                        canSync={sy.canSync}
                        where={(r.syncs ?? []).length > 1 ? sy.workstationName : undefined}
                      />
                    ))}
                </li>
              ))}
              {activeRepos.length === 0 && (
                <li className="text-sm text-subtle">No repositories yet. Add the first one below.</li>
              )}
            </ul>
            {traits.usesRepos && <AddRepoForm projectId={id} />}
          </Panel>
        </div>
      )}
      {project && repoUi && (
        <div id="commit-as" className="scroll-mt-20">
          <CommitAsPanel projectId={id} canEdit={project.myRole === 'owner' || canConvert} />
        </div>
      )}
      {project && repoUi && (q.data.environments ?? []).length > 0 && (
        <div id="environment" className="scroll-mt-20">
          <EnvironmentPanel
            projectId={id}
            environments={q.data.environments ?? []}
            canCheck={project.myRole === 'owner'}
          />
        </div>
      )}
      {project && repoUi && (
        <div id="phase-list" className="scroll-mt-20">
          <PhasesPanel projectId={id} />
        </div>
      )}
      {project && repoUi && (
        <div id="environments" className="scroll-mt-20">
          <EnvironmentsPointer projectId={id} projectKey={project.key} />
        </div>
      )}
      {project && repoUi && (
        <div id="reference-repos" className="scroll-mt-20">
          <ReferenceReposPanel
            projectId={id}
            referenceRepos={q.data.referenceRepos ?? []}
            candidates={q.data.referenceRepoCandidates ?? []}
            workstationRepos={q.data.referenceWorkstationRepos ?? []}
            workstationCandidates={q.data.workstationRepoCandidates ?? []}
            isOwner={project.myRole === 'owner'}
          />
        </div>
      )}
      {project && (
        <div id="mcp-servers" className="scroll-mt-20">
          <McpServersPanel
            projectId={id}
            granted={q.data.mcpServers ?? []}
            candidates={q.data.mcpServerCandidates ?? []}
            canGrant={q.data.canGrantMcpServers === true}
          />
        </div>
      )}
      {project && repoUi && (
        <div id="merge" className="scroll-mt-20">
          <MergePolicyPanel projectId={id} project={project} history={q.data.mergePolicyHistory ?? []} />
        </div>
      )}
      {project && traits.usesRepos && (
        <div id="architect" className="scroll-mt-20">
          <ArchitectPanel
            projectId={id}
            project={project}
            canChange={project.myRole === 'owner' || canConvert}
          />
        </div>
      )}
      {project && traits.usesRepos && (
        <div id="manual-qa" className="scroll-mt-20">
          <ManualQaPanel
            projectId={id}
            project={project}
            canChange={project.myRole === 'owner' || canConvert}
          />
        </div>
      )}
      {project && traits.usesRepos && (
        <div id="test-services" className="scroll-mt-20">
          <TestServicesPanel
            projectId={id}
            project={project}
            canChange={project.myRole === 'owner' || canConvert}
          />
        </div>
      )}
      {project && traits.usesRepos && (
        <div id="owner-approval" className="scroll-mt-20">
          <OwnerApprovalPanel
            projectId={id}
            project={project}
            canChange={project.myRole === 'owner' || canConvert}
          />
        </div>
      )}
      {project && traits.usesRepos && (
        <div id="claude-account" className="scroll-mt-20">
          <ClaudeAccountPanel
            projectId={id}
            project={project}
            canChange={project.myRole === 'owner' || canConvert}
          />
        </div>
      )}
      {project && traits.usesRepos && (
        <div id="provider-accounts" className="scroll-mt-20">
          <ProviderAccountPanel
            projectId={id}
            project={project}
            canChange={project.myRole === 'owner' || canConvert}
          />
        </div>
      )}
      {project && repoUi && (
        <div id="full-suite" className="scroll-mt-20">
          <FullSuitePanel
            projectId={id}
            project={project}
            canChange={project.myRole === 'owner' || canConvert}
            repos={activeRepos}
          />
        </div>
      )}
      {project && repoUi && (
        <div id="code-map" className="scroll-mt-20">
          <GraphStatusPanel projectId={id} canChange={project.myRole === 'owner' || canConvert} />
        </div>
      )}
      {project && traits.usesRepos && (
        <div id="policy" className="scroll-mt-20">
          <ProjectPolicyPanel
            projectId={id}
            project={project}
            canChange={project.myRole === 'owner' || canConvert}
          />
        </div>
      )}
      {project && (
        <div id="budget" className="scroll-mt-20">
          <BudgetPanel kind="projects" id={id} budget={project.budget} />
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
