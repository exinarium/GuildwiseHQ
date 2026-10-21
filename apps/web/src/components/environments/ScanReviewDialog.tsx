import { describeSetupStep, type ProposalDto, type SetupEnv } from '@aom/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useUseDeployProposal } from '../../api/queries/deploy-setup.ts';
import { useAnswerProposal } from '../../api/queries/environments.ts';
import { useDismissProposal, useRunPlanOverview, useSaveRunPlan } from '../../api/queries/run-plan.ts';
import { Badge, Button, Callout, Dialog, Disclosure, ErrorBox, useToast } from '../ui.tsx';
import { type Answered, AnswerFields, blockingQuestions, type Question } from './AnswerFields.tsx';
import { nativeOf } from './answers.ts';
import { ROLE_TITLE, roleOf } from './model.ts';

/**
 * "Review what we found" (docs/design/environments-ux.md journey A and G): one review for what DevOps suggests, with the
 * questions as real fields on top, then the start steps and the environments. Nothing is saved until "Use this", and what is
 * used becomes a draft the person still reviews, tries and approves.
 */
export function ScanReviewDialog({
  projectId,
  proposal,
  onClose,
  onUsed,
}: {
  projectId: string;
  proposal: ProposalDto;
  onClose: () => void;
  onUsed: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const answer = useAnswerProposal(projectId);
  const use = useUseDeployProposal(projectId);
  const dismiss = useDismissProposal(projectId);
  const runOverview = useRunPlanOverview(projectId);
  const saveRun = useSaveRunPlan(projectId);
  const p = proposal.proposal;
  const questions = p.questions as Question[];
  const answered = ((p as { answers?: Answered }).answers ?? {}) as Answered;
  const blocking = blockingQuestions(questions, answered);
  const envs = (p.deploy?.environments ?? []) as SetupEnv[];
  const runProposal = runOverview.data?.proposal?.proposal.run;
  const runProposalDto = runOverview.data?.proposal;
  const steps = runProposal ? [...runProposal.setup, ...runProposal.services] : [];
  const confidence = (path: string) => {
    const worst = (['unknown', 'guessed', 'found'] as const).find((c) =>
      p.items.some((i) => (i.path === path || i.path.startsWith(`${path}/`)) && i.confidence === c),
    );
    return worst ?? null;
  };
  const busy = use.isPending || dismiss.isPending || saveRun.isPending;

  const applyIt = async () => {
    try {
      if (runProposal && runProposalDto)
        await saveRun.mutateAsync({ plan: runProposal, scope: 'project', proposalId: runProposalDto.id });
      await use.mutateAsync(proposal.id);
      void qc.invalidateQueries({ queryKey: ['run-plan', projectId] });
      toast.success('Saved as a draft. Review, try and approve it below.');
      onUsed();
    } catch {
      // shown below
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Review what we found"
      size="xl"
      footer={
        <>
          <Button
            variant="ghost"
            disabled={busy}
            data-testid="proposal-dismiss"
            onClick={() => dismiss.mutate(proposal, { onSuccess: onClose })}
          >
            Dismiss
          </Button>
          <Button onClick={onClose}>Back</Button>
          <Button
            variant="primary"
            disabled={blocking.length > 0 || busy}
            loading={busy}
            onClick={() => void applyIt()}
            data-testid="proposal-use"
          >
            Use this
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5" data-testid="proposal-review">
        <p className="text-sm text-muted">
          {p.filesRead.length > 0
            ? `DevOps read ${p.filesRead.slice(0, 4).join(', ')}${p.filesRead.length > 4 ? ` and ${p.filesRead.length - 4} more` : ''} on ${proposal.workstationName}.`
            : `DevOps looked at the project on ${proposal.workstationName}.`}{' '}
          Nothing is saved until you press <strong>Use this</strong>.
        </p>
        {p.notes.trim() && (
          <Callout tone="info" title="DevOps says" data-testid="proposal-notes">
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{p.notes}</p>
          </Callout>
        )}

        {questions.length > 0 && (
          <AnswerFields
            questions={questions}
            answered={answered}
            pending={answer.isPending}
            error={answer.error}
            onSubmit={(a) => answer.mutate({ proposalId: proposal.id, answers: a })}
          />
        )}
        {blocking.length > 0 && (
          <p className="text-xs text-subtle" data-testid="proposal-blocking">
            Answer {blocking.length === 1 ? 'the open question' : `the ${blocking.length} open questions`}{' '}
            first, then "Use this" works.
          </p>
        )}

        <section className="flex flex-col gap-2" aria-label="Start steps" data-testid="review-start-steps">
          <h4 className="text-sm font-semibold text-fg">Start steps</h4>
          {steps.length > 0 ? (
            <ol className="flex flex-col gap-1.5">
              {steps.map((st) => (
                <li key={st.name} className="rounded-control bg-sunken px-3 py-2 text-sm">
                  <span className="font-medium text-fg">{st.label ?? st.name}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">
              No start steps in this suggestion. Guildwise keeps the ones you have, or you set them up in
              "Your app".
            </p>
          )}
        </section>

        <section className="flex flex-col gap-3" aria-label="Environments" data-testid="deploy-proposal-envs">
          <h4 className="text-sm font-semibold text-fg">Environments</h4>
          {envs.length === 0 && <p className="text-sm text-muted">DevOps found no environment to suggest.</p>}
          {envs.map((e, i) => {
            const c = confidence(`/environments/${i}`);
            const native = nativeOf(e);
            return (
              <div key={e.name} className="rounded-control border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h5 className="text-base font-semibold text-fg">{e.label}</h5>
                  <Badge>{ROLE_TITLE[roleOf(e)]}</Badge>
                  {c && (
                    <Badge tone={c === 'found' ? 'green' : c === 'guessed' ? 'amber' : 'red'}>
                      {c === 'found' ? 'Found' : c === 'guessed' ? 'Guessed: please check' : 'Unknown'}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted">
                  {e.hosting === 'ssh' ? `On a server (${e.host})` : 'On this computer'}.{' '}
                  {native
                    ? `Runs directly on the machine: ${native.name}.`
                    : `Updates the app part "${e.app.service}".`}
                </p>
                <Disclosure summary="Each update will" className="mt-1">
                  <ul className="list-disc pl-5 text-sm text-muted">
                    {e.steps.map((st, n) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a step has no id
                      <li key={n}>{describeSetupStep(st, e)}</li>
                    ))}
                  </ul>
                </Disclosure>
              </div>
            );
          })}
        </section>
        {p.secretsNeeded.length > 0 && (
          <Callout tone="warning" title="Passwords or keys the app needs">
            {p.secretsNeeded.join(', ')}. Guildwise never asks for their values here: keep them in a settings
            file on the computer.
          </Callout>
        )}
        <ErrorBox error={use.error ?? dismiss.error ?? saveRun.error} />
      </div>
    </Dialog>
  );
}
