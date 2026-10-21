import { useQueryClient } from '@tanstack/react-query';
import { Cloud, Plus, ScanSearch } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useDelivery, useInspectRecipe } from '../api/queries/delivery.ts';
import { useSetupState, useStartDeployScan } from '../api/queries/deploy-setup.ts';
import { useEnvStatus, useUnmodelledFiles } from '../api/queries/environments.ts';
import { useProjects } from '../api/queries/projects.ts';
import { useRunPlanOverview, useStartScan } from '../api/queries/run-plan.ts';
import { AdvancedSetup } from '../components/delivery/setup/AdvancedSetup.tsx';
import { AddServerDialog } from '../components/environments/AddPlaceDialogs.tsx';
import { blockingQuestions, type Question } from '../components/environments/AnswerFields.tsx';
import { EnvironmentCard } from '../components/environments/EnvironmentCard.tsx';
import { EnvironmentDialog } from '../components/environments/EnvironmentDialog.tsx';
import { HistorySection } from '../components/environments/HistorySection.tsx';
import { ImprovedSteps } from '../components/environments/ImprovedSteps.tsx';
import { allEnvironments, displayLabel, placesOf, roleOf } from '../components/environments/model.ts';
import { PlacesPanel } from '../components/environments/PlacesPanel.tsx';
import { CleanUpDialog } from '../components/environments/RemoveDialogs.tsx';
import { RulesSection } from '../components/environments/RulesSection.tsx';
import { ScanReviewDialog } from '../components/environments/ScanReviewDialog.tsx';
import { DeliverySecrets } from '../components/environments/SecretsPanel.tsx';
import { Section } from '../components/environments/Section.tsx';
import { TestCopiesCard } from '../components/environments/TestCopiesCard.tsx';
import { YourAppCard } from '../components/environments/YourAppCard.tsx';
import {
  Button,
  Callout,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Spinner,
  useToast,
} from '../components/ui.tsx';

/**
 * Project > Environments (docs/design/environments-ux.md section 3): one place to say where the app runs. Your app (how to
 * start it), the environments (test copies of cards, the test site, the live site, extra sites), the places they run on, the
 * rules and the history. The Owner changes things; everyone else sees the same page read-only.
 */
export function ProjectEnvironments() {
  const { projectKey = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.key === projectKey);
  if (projects.isPending)
    return (
      <div className="mx-auto max-w-4xl">
        <PageSkeleton label="Loading the environments" panels={3} />
      </div>
    );
  if (!project)
    return (
      <EmptyState
        icon={Cloud}
        tone="warning"
        title="That project does not exist or you do not have access"
        description={`Nothing is called ${projectKey}.`}
      />
    );
  return <EnvironmentsBody projectId={project.id} projectKey={project.key} projectName={project.name} />;
}

function EnvironmentsBody({
  projectId,
  projectKey,
  projectName,
}: {
  projectId: string;
  projectKey: string;
  projectName: string;
}) {
  const q = useSetupState(projectId);
  const status = useEnvStatus(projectId);
  const delivery = useDelivery(projectId);
  const run = useRunPlanOverview(projectId);
  const scanDeploy = useStartDeployScan(projectId);
  const scanRun = useStartScan(projectId);
  const inspect = useInspectRecipe(projectId);
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState<null | { role?: 'test' | 'live' | 'other' }>(null);
  const [addingServer, setAddingServer] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const s = q.data;
  const hasPlan = !!run.data?.projectPlan;
  const unmodelled = useUnmodelledFiles(projectId, s?.current.setup, s?.current.observedHash ?? 'none');

  // `?dialog=answer&proposal=<id>`: the desk item that deep-links to the questions
  useEffect(() => {
    if (params.get('dialog') === 'answer' && s?.proposal) {
      setReviewing(true);
      const next = new URLSearchParams(params);
      next.delete('dialog');
      next.delete('proposal');
      setParams(next, { replace: true });
    }
  }, [params, s?.proposal, setParams]);
  // the address may end in an anchor (#places, #start-steps)
  useEffect(() => {
    if (!s) return;
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [s]);

  const items = useMemo(() => (s ? allEnvironments(s) : []), [s]);
  if (q.isPending)
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="Environments" />
        <PageSkeleton label="Loading the environments" panels={3} />
      </div>
    );
  if (q.isError || !s)
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title={`${projectName} Environments`} />
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </div>
    );

  const places = placesOf(s);
  const labelOf = (name: string) => {
    const e = items.find((x) => x.env.name === name)?.env;
    return e ? displayLabel(e, roleOf(e)) : name;
  };
  const statusOf = (name: string) => status.data?.find((x) => x.env === name);
  const noneCan = s.workstations.length > 0 && s.workstations.every((w) => !w.canProbe);
  const dirty = !!s.draft?.setup && JSON.stringify(s.draft.setup) !== JSON.stringify(s.current.setup);
  const questions = (s.proposal?.proposal.questions ?? []) as Question[];
  const answered = ((
    s.proposal?.proposal as { answers?: Record<string, string | number | boolean> } | undefined
  )?.answers ?? {}) as Record<string, string | number | boolean>;
  const blocking = blockingQuestions(questions, answered);
  const empty = items.length === 0 && !s.current.custom;
  const unmodelledFiles = unmodelled.data ?? [];
  const oldCount = (s.draft && dirty ? 1 : 0) + unmodelledFiles.length;
  const recipe = delivery.data?.recipe;
  const liveEnvs = items.filter(
    (i) =>
      roleOf(
        i.env,
        places.find((p) => p.key === i.env.target),
      ) === 'live',
  );
  const approvedWaiting = items.filter((i) => statusOf(i.env.name)?.waitingRelease);

  const scanAll = () => {
    scanDeploy.mutate({}, { onSuccess: () => toast.success('DevOps is looking') });
    const w = run.data?.workstations.find((x) => x.canScan);
    if (w && !run.data?.scan && !run.data?.projectPlan) scanRun.mutate({ area: 'run', workstationId: w.id });
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5" data-testid="environments-page">
      <PageHeader
        title={`${projectName} Environments`}
        documentTitle={`${projectName} environments`}
        sub="Where your app runs. Guildwise looks at what is already there and never changes it without asking."
        actions={
          s.canEdit ? (
            <>
              <Button
                onClick={scanAll}
                loading={scanDeploy.isPending}
                disabled={!!s.scan}
                data-testid="setup-scan"
              >
                <ScanSearch aria-hidden="true" className="size-4" />
                Scan with DevOps
              </Button>
              <Button variant="primary" onClick={() => setAdding({})} data-testid="setup-add">
                <Plus aria-hidden="true" className="size-4" />
                Add an environment
              </Button>
            </>
          ) : undefined
        }
      />

      {!s.canEdit && (
        <p className="-mt-3 text-sm text-muted" data-testid="env-readonly">
          Only the project owner changes environments.
        </p>
      )}
      {noneCan && (
        <Callout
          tone="warning"
          title={`Guildwise on ${s.workstations.find((w) => w.blocked)?.name ?? 'your computer'} needs an update to set up environments`}
          data-testid="setup-runner-old"
        >
          {s.workstations.find((w) => w.blocked)?.blocked} The cards below still show what was last known.
        </Callout>
      )}
      {s.writeBlocked && !noneCan && (
        <Callout tone="warning" title="Saving is not possible yet" data-testid="setup-write-blocked">
          {s.writeBlocked}
        </Callout>
      )}
      {s.scan && (
        <Callout tone="info" title="DevOps is looking" data-testid="deploy-scan-progress" role="status">
          <div className="flex items-center gap-2">
            <Spinner inline label="Scanning" />
            DevOps is looking on {s.scan.workstationName}. Usually 2 to 5 minutes. You can leave this page.
          </div>
        </Callout>
      )}
      {!s.scan && s.scanProblem && (
        <Callout tone="warning" title="The scan did not give a result" data-testid="deploy-scan-problem">
          {s.scanProblem}
        </Callout>
      )}
      {s.proposal && blocking.length > 0 && (
        <Callout
          tone="warning"
          title={`DevOps asks ${blocking.length === 1 ? 'a question' : `${blocking.length} questions`}`}
          data-testid="needs-answer"
          actions={
            s.canEdit ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setReviewing(true)}
                data-testid="needs-answer-open"
              >
                Answer
              </Button>
            ) : undefined
          }
        >
          {blocking[0]?.question}
        </Callout>
      )}
      {s.proposal && blocking.length === 0 && (
        <Callout
          tone="info"
          title="DevOps has a suggestion"
          data-testid="deploy-proposal-waiting"
          actions={
            s.canEdit ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setReviewing(true)}
                data-testid="deploy-proposal-open"
              >
                Review
              </Button>
            ) : undefined
          }
        >
          {s.proposal.proposal.deploy?.environments.length ?? 0}{' '}
          {(s.proposal.proposal.deploy?.environments.length ?? 0) === 1 ? 'environment' : 'environments'}{' '}
          found.
        </Callout>
      )}
      {dirty && s.canEdit && (
        <Callout tone="info" title="You have unfinished changes" data-testid="setup-draft">
          Saved as a draft {s.draft ? new Date(s.draft.updatedAt).toLocaleString() : ''}. Nothing from it is
          in the project yet.
        </Callout>
      )}
      {s.publish?.status === 'failed' && (
        <Callout
          tone="danger"
          title="The last save did not work"
          data-testid="setup-publish-failed"
          role="alert"
        >
          {s.publish.error}
        </Callout>
      )}
      {s.publish?.status === 'pending' && (
        <Callout
          tone="info"
          title="Saving to the project's files"
          data-testid="setup-publish-pending"
          role="status"
        >
          <div className="flex items-center gap-2">
            <Spinner inline label="Saving" />
            The computer is writing the steps...
          </div>
        </Callout>
      )}
      {s.improvedAvailable && s.current.setup && <ImprovedSteps projectId={projectId} s={s} />}
      {approvedWaiting.length > 0 && (
        <Callout tone="info" data-testid="release-waiting-note">
          Waiting for you: {approvedWaiting.length} {approvedWaiting.length === 1 ? 'release' : 'releases'}.{' '}
          <a className="font-medium underline" href="/releases?tab=waiting">
            Open Releases
          </a>
        </Callout>
      )}

      {empty && (
        <section
          className="flex flex-col gap-3 rounded-card border border-dashed border-line bg-surface p-5"
          data-testid="setup-empty"
          aria-labelledby="empty-title"
        >
          <div>
            <h2 id="empty-title" className="text-lg font-semibold text-fg">
              Where does your app run?
            </h2>
            <p className="text-sm text-muted">Nothing is set up yet. Pick what you want first:</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Button
              className="h-auto min-h-16 flex-col items-start justify-start gap-1 py-3 text-left whitespace-normal"
              onClick={() => document.getElementById('start-steps')?.scrollIntoView({ block: 'start' })}
              data-testid="empty-card-tests"
            >
              <span className="font-semibold">I only want card test copies</span>
              <span className="text-xs font-normal text-muted">Start with your app's start steps</span>
            </Button>
            <Button
              className="h-auto min-h-16 flex-col items-start justify-start gap-1 py-3 text-left whitespace-normal"
              disabled={!s.canEdit}
              onClick={() => setAdding({ role: 'test' })}
              data-testid="empty-test-site"
            >
              <span className="font-semibold">A test site my team can try</span>
              <span className="text-xs font-normal text-muted">Then a live site later</span>
            </Button>
            <Button
              variant="primary"
              className="h-auto min-h-16 flex-col items-start justify-start gap-1 py-3 text-left whitespace-normal"
              disabled={!s.canEdit || !!s.scan}
              onClick={scanAll}
              data-testid="empty-scan"
            >
              <span className="font-semibold">Not sure: let DevOps look</span>
              <span className="text-xs font-normal opacity-90">At my project and my computer</span>
            </Button>
          </div>
          <p className="text-xs text-subtle">
            You can do all of it step by step, and nothing changes until you confirm.
          </p>
          <ErrorBox error={scanDeploy.error ?? scanRun.error} />
        </section>
      )}

      <YourAppCard projectId={projectId} canEdit={s.canEdit} />

      <section
        aria-labelledby="envs-title"
        className="flex flex-col gap-3"
        id="environments"
        data-testid="environments"
      >
        <h2 id="envs-title" className="text-sm font-semibold tracking-wide text-fg uppercase">
          Environments
        </h2>
        <ul className="flex flex-col gap-3" data-testid="setup-envs">
          <TestCopiesCard projectId={projectId} canEdit={s.canEdit} />
          {items.map(({ env, draft }) => (
            <EnvironmentCard
              key={env.name}
              projectId={projectId}
              s={s}
              env={env}
              draft={draft}
              places={places}
              status={statusOf(env.name)}
              hasPlan={hasPlan}
              labelOf={labelOf}
              changesSinceApproval={recipe?.changes ?? []}
              onAdvanced={() => setAdvanced(true)}
            />
          ))}
        </ul>
        {s.current.custom && (
          <Callout tone="info" title="These steps are a script" data-testid="setup-custom">
            The deploy files were written by hand or by DevOps, so they are shown as scripts. Let DevOps turn
            them into guided steps, or open the technical details.
          </Callout>
        )}
        {s.canEdit && (
          <div>
            <Button onClick={() => setAdding({})} data-testid="setup-add-below">
              <Plus aria-hidden="true" className="size-4" />
              Add an environment
            </Button>
          </div>
        )}
        {liveEnvs.length === 0 && items.length > 0 && s.canEdit && (
          <p className="text-xs text-subtle">No live site yet. Add one when the test site works.</p>
        )}
      </section>

      <Section
        id="places"
        title="Places"
        sub="Computers and servers this project can use."
        collapsible
        chip={<span className="text-xs text-subtle">{places.filter((p) => p.role === 'active').length}</span>}
      >
        <PlacesPanel projectId={projectId} s={s} onAddServer={() => setAddingServer(true)} />
      </Section>

      <RulesSection projectId={projectId} s={s} />
      <HistorySection projectId={projectId} labelOf={labelOf} />

      <Disclosure
        summary="Show technical details (setup file, scripts, what was found)"
        className="rounded-card border border-line bg-surface p-4"
        data-testid="technical-details"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setAdvanced(true)} data-testid="setup-advanced">
              Open the setup file and scripts
            </Button>
            {s.canEdit && (
              <Button
                variant="ghost"
                loading={inspect.isPending}
                onClick={() =>
                  inspect.mutate(undefined, {
                    onSuccess: () => {
                      toast.success('Checking the deploy files');
                      void qc.invalidateQueries({ queryKey: ['deploy-setup', projectId] });
                    },
                  })
                }
              >
                Check for changes
              </Button>
            )}
          </div>
          {delivery.data && <DeliverySecrets projectId={projectId} d={delivery.data} />}
          <div
            className="flex flex-wrap items-center gap-2 border-t border-line pt-3"
            data-testid="old-setups"
          >
            <span className="text-sm text-fg">Old setups and drafts ({oldCount})</span>
            {s.canEdit && oldCount > 0 && (
              <Button size="sm" onClick={() => setCleaning(true)} data-testid="cleanup-open">
                Clean up
              </Button>
            )}
          </div>
        </div>
      </Disclosure>

      {adding && (
        <EnvironmentDialog
          projectId={projectId}
          state={s}
          initialRole={adding.role}
          onClose={() => setAdding(null)}
          onAdvanced={() => {
            setAdding(null);
            setAdvanced(true);
          }}
        />
      )}
      {addingServer && (
        <AddServerDialog
          projectId={projectId}
          state={s}
          onClose={() => setAddingServer(false)}
          onAdded={() => setAddingServer(false)}
        />
      )}
      {reviewing && s.proposal && (
        <ScanReviewDialog
          projectId={projectId}
          proposal={s.proposal}
          onClose={() => setReviewing(false)}
          onUsed={() => setReviewing(false)}
        />
      )}
      {advanced && (
        <Dialog open onOpenChange={(o) => !o && setAdvanced(false)} title="Technical details" size="xl">
          <AdvancedSetup projectId={projectId} state={s} onClose={() => setAdvanced(false)} />
        </Dialog>
      )}
      {cleaning && (
        <CleanUpDialog
          projectId={projectId}
          s={s}
          unmodelled={unmodelledFiles}
          onClose={() => setCleaning(false)}
        />
      )}
      <p className="sr-only">{projectKey}</p>
    </div>
  );
}
