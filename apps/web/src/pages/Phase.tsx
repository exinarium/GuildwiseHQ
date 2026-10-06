import type { FollowupSpec, PhaseDetailDto } from '@aom/shared';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useBoard } from '../api/queries/board.ts';
import { useThreadMessages } from '../api/queries/chats.ts';
import {
  useAssignCardPhase,
  useConfirmMerged,
  useDeployTargets,
  usePatchPhase,
  usePhaseByNumber,
  useReopenPhase,
  useSetPhaseFollowups,
} from '../api/queries/phases.ts';
import { useProjects } from '../api/queries/projects.ts';
import { FollowupEditor, followupProblems } from '../components/FollowupEditor.tsx';
import {
  Badge,
  Button,
  ButtonLink,
  Dialog,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
  Select,
  TextArea,
  TextInput,
  useToast,
} from '../components/ui.tsx';
import { OUTCOME_LABEL, PHASE_STATUS_LABEL, phaseTone, specOf } from '../lib/phases.ts';
import { formatDateTime } from '../lib/time.ts';

/** One phase: its cards, follow-ups (editable until approved), the BA's reports and the thread of progress notes. */
export function Phase() {
  const { projectKey = '', number = '' } = useParams();
  const q = usePhaseByNumber(projectKey, Number(number));
  if (q.isPending)
    return (
      <div className="mx-auto max-w-4xl">
        <PageSkeleton label="Loading the phase" panels={3} />
      </div>
    );
  if (q.isError)
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="Phase" />
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  return <PhaseView phase={q.data} />;
}

function PhaseView({ phase }: { phase: PhaseDetailDto }) {
  const projects = useProjects();
  const project = projects.data?.find((p) => p.id === phase.projectId);
  const targets = useDeployTargets(phase.projectId);
  const patch = usePatchPhase(phase.id);
  const reopen = useReopenPhase(phase.id);
  const toast = useToast();
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [name, setName] = useState(phase.name);
  const [description, setDescription] = useState(phase.description);
  useEffect(() => {
    setName(phase.name);
    setDescription(phase.description);
  }, [phase.name, phase.description]);
  const final = ['done', 'done_with_failures', 'followups_rejected', 'discarded', 'cancelled'].includes(
    phase.status,
  );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4" data-testid="phase-page">
      <PageHeader
        title={`${phase.ref} ${phase.name}`}
        back={{ to: `/p/${project?.key ?? phase.ref.split('-')[0]}/board`, label: 'Back to the board' }}
        sub={
          <span className="flex flex-wrap items-center gap-1.5">
            <span data-testid="phase-status">
              <Badge tone={phaseTone(phase.status)}>{PHASE_STATUS_LABEL[phase.status]}</Badge>
            </span>
            <span>
              {phase.createdBy.kind === 'agent'
                ? `proposed by ${phase.createdBy.name ?? 'the BA'}`
                : `created by ${phase.createdBy.name ?? 'a member'}`}
            </span>
            {phase.workingBranch && <Badge title="Working branch of this phase">{phase.workingBranch}</Badge>}
          </span>
        }
        actions={
          <>
            {phase.canReopen && (
              <Button data-testid="reopen-phase" onClick={() => setReopenOpen(true)}>
                Reopen phase
              </Button>
            )}
            {project && <ButtonLink to={`/projects/${project.id}/settings`}>Project settings</ButtonLink>}
          </>
        }
      />

      {!final && (
        <Panel>
          <form
            className="flex flex-col gap-2"
            aria-label="Phase details"
            onSubmit={(e) => {
              e.preventDefault();
              patch.mutate(
                { name: name.trim(), description },
                { onSuccess: () => toast.success('Phase saved') },
              );
            }}
          >
            <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <TextArea
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <ErrorBox error={patch.error} />
            <Button type="submit" className="self-start" disabled={patch.isPending || !name.trim()}>
              Save
            </Button>
          </form>
        </Panel>
      )}

      <Members phase={phase} />
      <Followups phase={phase} targets={targets.data ?? []} />

      {phase.report && (
        <Panel data-testid="phase-report">
          <h2 className="mb-2 text-lg font-semibold text-fg">Report</h2>
          <p className="text-base whitespace-pre-wrap text-fg">{phase.report}</p>
          {phase.outstanding.length > 0 && (
            <>
              <h3 className="mt-3 text-sm font-semibold text-fg">Outstanding</h3>
              <ul className="list-disc pl-5 text-sm">
                {phase.outstanding.map((o) => (
                  <li key={o.text}>{o.text}</li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      )}
      {phase.resultsReport && (
        <Panel data-testid="phase-results">
          <h2 className="mb-2 text-lg font-semibold text-fg">Follow-up results</h2>
          <p className="text-base whitespace-pre-wrap text-fg">{phase.resultsReport}</p>
        </Panel>
      )}
      {phase.tasks.length > 0 && (
        <Panel>
          <h2 className="mb-2 text-lg font-semibold text-fg">BA tasks</h2>
          <ul className="text-sm" data-testid="ba-tasks">
            {phase.tasks.map((t) => (
              <li key={t.id}>
                {t.kind.replaceAll('_', ' ')}: {t.status}
                {t.status === 'fallback' ? ' (the server wrote a template: no BA took it)' : ''}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <Thread threadId={phase.threadId} />

      <Dialog
        open={reopenOpen}
        onOpenChange={setReopenOpen}
        title="Reopen the phase"
        description="It waits for its cards again; the report and its approval are discarded."
      >
        <div className="flex flex-col gap-3">
          <TextArea label="Why" value={reason} onChange={(e) => setReason(e.target.value)} />
          <ErrorBox error={reopen.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setReopenOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              data-testid="reopen-confirm"
              disabled={!reason.trim() || reopen.isPending}
              onClick={() =>
                reopen.mutate(reason.trim(), {
                  onSuccess: () => {
                    setReopenOpen(false);
                    toast.success('Phase reopened');
                  },
                })
              }
            >
              Reopen
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function Members({ phase }: { phase: PhaseDetailDto }) {
  const assign = useAssignCardPhase();
  const confirm = useConfirmMerged();
  const board = useBoard(phase.projectId);
  const [pick, setPick] = useState('');
  const inPhase = new Set(phase.members.map((m) => m.cardId));
  const candidates = (board.data?.columns ?? [])
    .flatMap((c) => c.cards)
    .filter(
      (c) =>
        !inPhase.has(c.id) &&
        !c.phase &&
        c.status !== 'done' &&
        c.status !== 'cancelled' &&
        c.cardType !== 'regression' &&
        c.origin !== 'full_suite' &&
        c.origin !== 'regression',
    );
  return (
    <Panel data-testid="phase-members">
      <h2 className="mb-3 text-lg font-semibold text-fg">
        Cards ({phase.resolvedCount}/{phase.memberCount} done
        {phase.proposedCount ? `, ${phase.proposedCount} proposed` : ''})
      </h2>
      <p className="mb-2 text-xs text-subtle">
        The phase is complete when every card is finalized and its work is in the working branch, closed or
        cancelled.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-subtle">
            <th className="py-1 pr-2">Card</th>
            <th className="py-1 pr-2">State</th>
            <th className="py-1 pr-2">Result</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {phase.members.map((m) => (
            <tr key={m.cardId} data-testid={`member-${m.ref}`} className="border-t border-line">
              <td className="py-1 pr-2">
                <Link to={`/cards/${m.cardId}`} className="underline">
                  {m.ref}
                </Link>{' '}
                {m.title}
                {m.assignment === 'proposed' && (
                  <span className="ml-1">
                    <Badge tone="amber" title="The BA proposed it; the manager has not confirmed it yet">
                      proposed
                    </Badge>
                  </span>
                )}
              </td>
              <td className="py-1 pr-2">
                {m.status}
                <span className="text-xs text-subtle"> · {m.stage}</span>
              </td>
              <td className="py-1 pr-2 text-xs">
                {m.outcome ? OUTCOME_LABEL[m.outcome] : '-'}
                {m.resultRef?.mergeCommit && (
                  <span className="font-mono"> {m.resultRef.mergeCommit.slice(0, 10)}</span>
                )}
                {m.resultRef?.prUrl && (
                  <>
                    {' '}
                    <a
                      href={m.resultRef.prUrl}
                      className="underline"
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      PR
                    </a>
                  </>
                )}
                {m.resultRef?.pushedBranch && <span className="font-mono"> {m.resultRef.pushedBranch}</span>}
                {m.outcome === 'finalized' && m.action !== 'merge' && m.merged && ' · merged'}
              </td>
              <td className="py-1 text-right">
                {m.canConfirmMerge && (
                  <Button
                    variant="ghost"
                    data-testid={`confirm-merged-${m.ref}`}
                    title="The automatic check cannot see it (a squash merge, a deleted branch): say it is in the working branch"
                    onClick={() => confirm.mutate({ cardId: m.cardId })}
                  >
                    Mark merged
                  </Button>
                )}
                {phase.canAssign && m.status !== 'done' && m.status !== 'cancelled' && (
                  <Button
                    variant="ghost"
                    aria-label={`Take ${m.ref} out of the phase`}
                    onClick={() => assign.mutate({ cardId: m.cardId, phaseId: null })}
                  >
                    Remove
                  </Button>
                )}
              </td>
            </tr>
          ))}
          {phase.members.length === 0 && (
            <tr>
              <td colSpan={4} className="py-2 text-sm text-subtle">
                No cards yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {phase.canAssign && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-60 flex-1">
            <Select label="Add a card" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a card</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.ref} {c.title}
                </option>
              ))}
            </Select>
          </div>
          <Button
            data-testid="add-card"
            disabled={!pick || assign.isPending}
            onClick={() =>
              assign.mutate({ cardId: pick, phaseId: phase.id }, { onSuccess: () => setPick('') })
            }
          >
            Add
          </Button>
        </div>
      )}
      <ErrorBox error={assign.error ?? confirm.error} />
    </Panel>
  );
}

function Followups({
  phase,
  targets,
}: {
  phase: PhaseDetailDto;
  targets: import('@aom/shared').DeployTargetDto[];
}) {
  const save = useSetPhaseFollowups(phase.id);
  const server = phase.followupDetails.map(specOf);
  const [draft, setDraft] = useState<FollowupSpec[] | null>(null);
  const list = draft ?? server;
  return (
    <Panel data-testid="phase-followups">
      <h2 className="mb-2 text-lg font-semibold text-fg">Follow-ups</h2>
      {phase.canEditFollowups ? (
        <>
          <FollowupEditor value={list} onChange={setDraft} targets={targets} />
          <ErrorBox error={save.error} />
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              data-testid="save-followups"
              disabled={save.isPending || draft === null || followupProblems(list, targets).length > 0}
              onClick={() => save.mutate(list, { onSuccess: () => setDraft(null) })}
            >
              Save follow-ups
            </Button>
            {phase.status === 'awaiting_approval' && (
              <span className="text-xs text-subtle">Approve them on the desk once you are happy.</span>
            )}
          </div>
        </>
      ) : (
        <FollowupEditor value={server} targets={targets} readOnly details={phase.followupDetails} />
      )}
    </Panel>
  );
}

function Thread({ threadId }: { threadId: string }) {
  const q = useThreadMessages(threadId);
  const messages = q.data?.messages ?? [];
  return (
    <Panel>
      <h2 className="mb-3 text-lg font-semibold text-fg">Progress</h2>
      <ul className="flex flex-col gap-1.5 text-sm" data-testid="phase-thread">
        {messages.map((m) => (
          <li key={m.id}>
            <span className="text-xs text-subtle">
              {formatDateTime(m.createdAt)} · {m.authorName ?? m.authorKind}:{' '}
            </span>
            <span className="whitespace-pre-wrap">{m.body}</span>
          </li>
        ))}
        {messages.length === 0 && <li className="text-subtle">Nothing yet.</li>}
      </ul>
    </Panel>
  );
}
