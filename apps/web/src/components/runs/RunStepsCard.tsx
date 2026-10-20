import {
  describeService,
  describeStep,
  itemLabel,
  type ProposalDto,
  type RunPlan,
  RunPlanSchema,
  type RunPlanVersionDto,
  validateRunPlanPlain,
} from '@aom/shared';
import { Pencil, ScanSearch } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  useDiscardWorkstationPlan,
  useDismissProposal,
  useRunPlanOverview,
  useSaveRunPlan,
  useStartScan,
} from '../../api/queries/run-plan.ts';
import { useRunSettings, useSaveRunSettings } from '../../api/queries/runs.ts';
import { ageLabel } from '../../lib/time.ts';
import { ProposalReview, type ReviewQuestion } from '../setup/ProposalReview.tsx';
import { Badge, Button, Callout, Dialog, ErrorBox, Select, Spinner, TextArea, useToast } from '../ui.tsx';
import { entriesToPlan, type PlanEntry, planToEntries, unansweredCount } from './plan-entries.ts';
import { RunStepsEditor } from './RunStepsEditor.tsx';
import { RunTestPanel } from './RunTestPanel.tsx';

const ago = (iso: string) => {
  const a = ageLabel(iso);
  return a === 'now' ? 'just now' : `${a} ago`;
};

const countText = (plan: RunPlan) => {
  const n = plan.setup.length + plan.services.length;
  return `${n} ${n === 1 ? 'step' : 'steps'}`;
};

const EMPTY_PLAN: RunPlan = RunPlanSchema.parse({});

/**
 * Project settings > Run and test: how to start this app, in plain words (docs/design/deploy-run-ux-design.md section 3.1).
 * Shows whether it is set up, lets the owner scan with DevOps or edit the steps through templates, test them, and review
 * what DevOps suggests. Everything edits the one project-wide run plan the runner replays on every computer.
 */
export function RunStepsCard({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const overview = useRunPlanOverview(projectId);
  const save = useSaveRunPlan(projectId);
  const discard = useDiscardWorkstationPlan(projectId);
  const dismiss = useDismissProposal(projectId);
  const toast = useToast();
  const [draft, setDraft] = useState<PlanEntry[] | null>(null);
  const [reviewing, setReviewing] = useState<PlanEntry[] | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);

  const o = overview.data;
  const base = o?.projectPlan?.plan ?? EMPTY_PLAN;
  const draftPlan = useMemo(() => (draft ? entriesToPlan(base, draft) : null), [draft, base]);
  const problems = useMemo(() => (draftPlan ? validateRunPlanPlain(draftPlan) : []), [draftPlan]);

  if (overview.isPending) return <Spinner label="Loading the run steps" />;
  if (overview.isError) return <ErrorBox error={overview.error} onRetry={() => overview.refetch()} />;
  if (!o) return null;
  const repos = o.repos;

  // ---------------------------------------------------------------------------- edit
  if (draft && draftPlan) {
    const doSave = () =>
      save.mutate(
        { plan: draftPlan, scope: 'project', source: 'owner' },
        {
          onSuccess: () => {
            setDraft(null);
            toast.success('Run steps saved');
          },
        },
      );
    return (
      <div className="flex flex-col gap-4" data-testid="run-steps-edit">
        <div>
          <h3 className="text-base font-semibold text-fg">Edit the run steps</h3>
          <p className="text-sm text-muted">
            Guildwise runs these in order whenever someone starts the app or a card is tested.
          </p>
        </div>
        <RunStepsEditor entries={draft} onChange={setDraft} repos={repos} />
        {problems.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-danger" role="alert" data-testid="run-steps-problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <ErrorBox error={save.error} />
        <RunTestPanel projectId={projectId} plan={draftPlan} workstations={o.workstations} />
        <div className="flex flex-col-reverse gap-2 border-t border-line pt-3 sm:flex-row">
          <Button onClick={() => setDraft(null)} data-testid="run-steps-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={doSave}
            loading={save.isPending}
            disabled={problems.length > 0}
            data-testid="run-steps-save"
          >
            Use these steps
          </Button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------- review a scan
  if (reviewing && o.proposal?.proposal.run) {
    return (
      <ScanReview
        projectId={projectId}
        proposal={o.proposal}
        entries={reviewing}
        setEntries={setReviewing}
        editingKey={editingKey}
        setEditingKey={setEditingKey}
        hasPlan={!!o.projectPlan}
        repos={repos}
        workstations={o.workstations}
        saving={save.isPending}
        error={save.error}
        onUse={() => {
          const plan = entriesToPlan(o.proposal?.proposal.run ?? base, reviewing);
          save.mutate(
            { plan, scope: 'project', source: 'scan', proposalId: (o.proposal as ProposalDto).id },
            {
              onSuccess: () => {
                setReviewing(null);
                toast.success('Run steps saved');
              },
            },
          );
        }}
        onDismiss={() =>
          dismiss.mutate(o.proposal as ProposalDto, {
            onSuccess: () => {
              setReviewing(null);
              toast.success('Suggestion put away');
            },
          })
        }
        onBack={() => setReviewing(null)}
      />
    );
  }

  // ---------------------------------------------------------------------------- overview
  const plan = o.projectPlan?.plan;
  const own = o.workstationPlans;
  const failure = o.projectPlan?.lastFailure ?? (o.lastStart?.state === 'failed' ? o.lastStart : null);
  const startEdit = (from?: RunPlan) => {
    setDraft(planToEntries(from ?? plan ?? own[0]?.plan ?? EMPTY_PLAN));
  };

  return (
    <div className="flex flex-col gap-4" data-testid="run-steps-card">
      <div>
        <h3 className="text-base font-semibold text-fg">How to start this app</h3>
        {plan ? (
          <p className="text-sm text-muted" data-testid="run-steps-state">
            Starts in {countText(plan)} on any computer of this project.
            {o.lastStart && o.lastStart.state !== 'running' && (
              <>
                {' '}
                Last start: {o.lastStart.state === 'ok' ? 'worked' : 'failed'} {ago(o.lastStart.at)} on{' '}
                {o.lastStart.workstationName}.
              </>
            )}
          </p>
        ) : (
          <p className="text-sm text-muted" data-testid="run-steps-state">
            Not set up yet. Guildwise does not know how to start this app yet. Card tests need this.
          </p>
        )}
      </div>

      {o.scan && (
        <Callout tone="info" title="DevOps is reading the project" data-testid="scan-progress">
          <div className="flex items-center gap-2">
            <Spinner inline label="Scanning" />
            <span>
              On {o.scan.workstationName}, usually 2 to 5 minutes. You can leave this page; the suggestion
              shows up here.
            </span>
          </div>
        </Callout>
      )}
      {!o.scan && o.scanProblem && (
        <Callout tone="warning" title="The scan did not give a result" data-testid="scan-problem">
          {o.scanProblem} You can try again, or set the steps up yourself.
        </Callout>
      )}
      {o.proposal?.proposal.run && (
        <Callout
          tone="info"
          title="DevOps has a suggestion"
          data-testid="proposal-waiting"
          actions={
            canEdit ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setReviewing(planToEntries(o.proposal?.proposal.run as RunPlan, o.proposal?.proposal));
                }}
                data-testid="proposal-review-open"
              >
                Review
              </Button>
            ) : undefined
          }
        >
          {countText(o.proposal.proposal.run)} found
          {o.proposal.proposal.questions.length > 0
            ? `, ${o.proposal.proposal.questions.length} ${o.proposal.proposal.questions.length === 1 ? 'question' : 'questions'} for you`
            : ''}
          .
        </Callout>
      )}
      {failure && (
        <Callout tone="danger" title="The last start failed" data-testid="run-steps-failure">
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {('reason' in failure
              ? failure.reason
              : (failure.failure ?? 'Something went wrong while starting.')
            ).slice(0, 400)}
          </p>
          <p className="text-xs">
            {own.length > 0
              ? 'DevOps saved a fix for the computer below.'
              : 'DevOps looks at it when the next start fails. You can also scan again.'}
          </p>
        </Callout>
      )}

      {canEdit ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            variant={plan ? 'secondary' : 'primary'}
            onClick={() => setScanOpen(true)}
            disabled={!!o.scan}
            data-testid="scan-open"
          >
            <ScanSearch aria-hidden="true" className="size-4" />
            Scan with DevOps
          </Button>
          <Button onClick={() => startEdit()} data-testid="run-steps-edit-open">
            <Pencil aria-hidden="true" className="size-4" />
            {plan ? 'Edit steps' : 'Set up myself'}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-subtle">Only the project owner can change the run steps.</p>
      )}

      {plan && <PlanSummary plan={plan} version={o.projectPlan as RunPlanVersionDto} />}

      {plan && canEdit && (
        <div className="border-t border-line pt-3">
          <RunTestPanel projectId={projectId} workstations={o.workstations} />
        </div>
      )}
      <AllowDockerHint projectId={projectId} plans={[plan, ...own.map((p) => p.plan)]} canEdit={canEdit} />

      {own.length > 0 && (
        <section
          className="flex flex-col gap-2"
          aria-label="Steps of single computers"
          data-testid="run-own-plans"
        >
          <h4 className="text-sm font-semibold text-fg">Computers with their own steps</h4>
          {own.map((p) => (
            <div
              key={p.id}
              className="flex flex-col gap-2 rounded-control border border-line p-3 text-sm"
              data-testid={`own-plan-${p.workstationName}`}
            >
              <p>
                <strong>{p.workstationName}</strong> uses its own version
                {p.source === 'devops' ? ' (saved by DevOps after a start went wrong)' : ''},{' '}
                {countText(p.plan)}, saved {ago(p.savedAt)}.{plan ? '' : ' There is no project version yet.'}
              </p>
              {canEdit && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  {plan && (
                    <Button
                      size="sm"
                      onClick={() =>
                        discard.mutate(p.id, {
                          onSuccess: () => toast.success(`${p.workstationName} uses the project version`),
                        })
                      }
                      loading={discard.isPending}
                    >
                      Use the project version here
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={() =>
                      save.mutate(
                        { plan: p.plan, scope: 'project', source: 'owner' },
                        { onSuccess: () => toast.success('Now the project version') },
                      )
                    }
                    loading={save.isPending}
                  >
                    Make this the project version
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => startEdit(p.plan)}>
                    Edit a copy
                  </Button>
                </div>
              )}
            </div>
          ))}
          <ErrorBox error={discard.error ?? save.error} />
        </section>
      )}

      {scanOpen && (
        <ScanDialog projectId={projectId} workstations={o.workstations} onClose={() => setScanOpen(false)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- pieces

function PlanSummary({ plan, version }: { plan: RunPlan; version: RunPlanVersionDto }) {
  return (
    <section className="flex flex-col gap-2" aria-label="The steps" data-testid="run-plan-summary">
      <h4 className="text-sm font-semibold text-fg">
        The steps{' '}
        <span className="text-xs font-normal text-subtle">
          {version.source === 'devops'
            ? 'saved by DevOps'
            : version.source === 'scan'
              ? 'from a DevOps scan'
              : 'written by hand'}
          , {ago(version.savedAt)}
        </span>
      </h4>
      <ol className="flex flex-col gap-1.5">
        {plan.setup.map((s) => (
          <li key={`s-${s.name}`} className="rounded-control bg-sunken px-3 py-2 text-sm">
            <span className="font-medium text-fg">{itemLabel(s)}</span>
            <span className="block text-xs text-muted [overflow-wrap:anywhere]">{describeStep(s)}</span>
          </li>
        ))}
        {plan.services.map((s) => (
          <li key={`v-${s.name}`} className="rounded-control bg-sunken px-3 py-2 text-sm">
            <span className="font-medium text-fg">{itemLabel(s)}</span>{' '}
            {s.docker && <Badge tone="info">Docker</Badge>}
            <span className="block text-xs text-muted [overflow-wrap:anywhere]">{describeService(s)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ScanDialog({
  projectId,
  workstations,
  onClose,
}: {
  projectId: string;
  workstations: Array<{ id: string; name: string; canScan: boolean; scanBlocked: string | null }>;
  onClose: () => void;
}) {
  const scan = useStartScan(projectId);
  const toast = useToast();
  const usable = workstations.filter((w) => w.canScan);
  const [wsId, setWsId] = useState(usable[0]?.id ?? '');
  const [note, setNote] = useState('');
  const blocked = workstations.filter((w) => !w.canScan);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Scan with DevOps"
      description="DevOps reads the project's files and suggests how to start it. It only reads: it does not start, install or change anything. You review the suggestion before anything is saved."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!wsId}
            loading={scan.isPending}
            data-testid="scan-start"
            onClick={() =>
              scan.mutate(
                { area: 'run', workstationId: wsId, ...(note.trim() ? { note: note.trim() } : {}) },
                {
                  onSuccess: () => {
                    toast.success('DevOps is reading the project');
                    onClose();
                  },
                },
              )
            }
          >
            Start the scan
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {usable.length > 0 ? (
          <Select label="Which computer?" value={wsId} onChange={(e) => setWsId(e.target.value)}>
            {usable.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        ) : (
          <Callout tone="warning" title="No computer can scan right now" data-testid="scan-blocked">
            <ul className="list-disc pl-4">
              {blocked.map((w) => (
                <li key={w.id}>{w.scanBlocked ?? `${w.name} cannot scan.`}</li>
              ))}
              {blocked.length === 0 && <li>You have no computer with Guildwise and the project's code.</li>}
            </ul>
          </Callout>
        )}
        <TextArea
          label="Anything DevOps should know? (optional)"
          rows={3}
          value={note}
          placeholder="The website is in the web folder. It needs a PostgreSQL database."
          onChange={(e) => setNote(e.target.value)}
        />
        <ErrorBox error={scan.error} />
      </div>
    </Dialog>
  );
}

function ScanReview({
  projectId,
  proposal,
  entries,
  setEntries,
  editingKey,
  setEditingKey,
  hasPlan,
  repos,
  workstations,
  saving,
  error,
  onUse,
  onDismiss,
  onBack,
}: {
  projectId: string;
  proposal: ProposalDto;
  entries: PlanEntry[];
  setEntries: (e: PlanEntry[]) => void;
  editingKey: string | null;
  setEditingKey: (k: string | null) => void;
  hasPlan: boolean;
  repos: Array<{ repoId: string; name: string }>;
  workstations: Parameters<typeof RunTestPanel>[0]['workstations'];
  saving: boolean;
  error: unknown;
  onUse: () => void;
  onDismiss: () => void;
  onBack: () => void;
}) {
  const run = proposal.proposal.run as RunPlan;
  const plan = entriesToPlan(run, entries);
  const problems = validateRunPlanPlain(plan);
  const blocking = unansweredCount(entries) + problems.length;

  // A question belongs to the part its path points into (/services/0/... or /setup/0/...).
  const owner = (path: string): PlanEntry | undefined => {
    const m = /^\/(setup|services)\/(\d+)(?:\/|$)/.exec(path);
    if (!m) return undefined;
    const kind = m[1] === 'setup' ? 'step' : 'service';
    return entries.filter((e) => e.kind === kind)[Number(m[2])];
  };
  const questions: ReviewQuestion[] = proposal.proposal.questions.map((q) => {
    const e = owner(q.path);
    return {
      ...q,
      answered: !!e?.review?.confirmed,
      ...(e ? { onAnswer: () => setEditingKey(e.key) } : {}),
    };
  });
  const banners = (key: string): string[] =>
    proposal.proposal.questions
      .filter((q) => owner(q.path)?.key === key)
      .map((q) => `${q.question}${q.default ? ` (usually ${q.default})` : ''}`);

  return (
    <div className="flex flex-col gap-3" data-testid="run-scan-review">
      <button
        type="button"
        className="self-start text-sm text-brand-text underline-offset-2 hover:underline"
        onClick={onBack}
      >
        Back
      </button>
      {hasPlan && <Callout tone="warning">Using these steps replaces the steps that are saved now.</Callout>}
      <ProposalReview
        proposal={proposal}
        questions={questions}
        blocking={blocking}
        useLabel="Use these steps"
        onUse={onUse}
        onDismiss={onDismiss}
        busy={saving}
        testSlot={
          <RunTestPanel
            projectId={projectId}
            plan={plan}
            workstations={workstations}
            label="Test first"
            disabledReason={blocking > 0 ? 'Answer the open questions to test.' : undefined}
          />
        }
      >
        <RunStepsEditor
          entries={entries}
          onChange={setEntries}
          repos={repos}
          review
          editingKey={editingKey}
          onEditingKeyChange={setEditingKey}
          bannersFor={banners}
        />
        {problems.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-danger" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </ProposalReview>
      <ErrorBox error={error} />
    </div>
  );
}

/** Docker steps need the project's Docker opt-in, which lives under the technical details. */
function AllowDockerHint({
  projectId,
  plans,
  canEdit,
}: {
  projectId: string;
  plans: Array<RunPlan | undefined>;
  canEdit: boolean;
}) {
  const settings = useRunSettings(projectId);
  const saveSettings = useSaveRunSettings(projectId);
  const toast = useToast();
  const uses = plans.some((p) => p?.services.some((s) => s.docker));
  const data = settings.data;
  if (!uses || !data?.settings || data.settings.allowDocker) return null;
  return (
    <Callout
      tone="warning"
      title="These steps use Docker"
      data-testid="docker-hint"
      actions={
        canEdit ? (
          <Button
            size="sm"
            loading={saveSettings.isPending}
            onClick={() =>
              saveSettings.mutate(
                {
                  runInstructions: data.runInstructions,
                  repoInstructions: data.repos.map((r) => ({
                    repoId: r.repoId,
                    runInstructions: r.runInstructions,
                  })),
                  settings: { ...data.settings, allowDocker: true },
                },
                { onSuccess: () => toast.success('Docker is allowed for this project') },
              )
            }
          >
            Allow Docker
          </Button>
        ) : undefined
      }
    >
      Docker is off for this project, so these parts will not start. Docker gives the code full access to the
      computer, so only allow it for code you trust.
    </Callout>
  );
}
