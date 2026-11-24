import {
  type BaTaskShift,
  type CeoShift,
  type DevopsShift,
  dropSections,
  ENVIRONMENT_HELP_SECTION,
  type QuestionShift,
  renderBaTaskInstructions,
  renderBaTaskPrompt,
  renderCeoInstructions,
  renderCeoPrompt,
  renderDevopsInstructions,
  renderDevopsPrompt,
  renderInstructions,
  renderQuestionInstructions,
  renderQuestionPrompt,
  renderReleasePrepInstructions,
  renderReleasePrepPrompt,
  renderShiftPrompt,
  roleSectionsToDrop,
  type ServerToRunnerOf,
  type ShiftBrief,
} from '@aom/shared';
import type { DevopsGuardInput } from '../adapters/types.ts';

type ShiftStartMsg = ServerToRunnerOf<'shift.start'>;

/** A DevOps shift works one request of this workstation's DevOps engineer; it has no card or worktree. */
export const devopsOf = (msg: ShiftStartMsg): DevopsShift | undefined =>
  msg.kind === 'devops' ? msg.devops : undefined;

/**
 * The guard hook configuration of a shift of the workstation's DevOps engineer (it runs outside the sandbox, so the hook
 * is its guardrail). Its own requests (`devops`) and, since GWP-189, the release prep tasks (`release_prep`) it writes; no
 * other shift kind, and no other agent, gets a guard. The working branch of the project is protected from force-pushes.
 */
export function devopsGuardFor(
  msg: ShiftStartMsg,
  identityEmail?: string | null,
): DevopsGuardInput | undefined {
  if (!guardedShift(msg)) return undefined;
  if (msg.kind === 'release_prep') {
    // the release branch is frozen for the whole shift; nothing is pre-approved
    const branch = msg.releasePrep?.releaseBranch?.trim();
    if (!branch) return undefined;
    return {
      sessionRef: msg.shiftId,
      shiftKind: 'release_prep',
      protectedBranches: [branch],
      frozenBranches: [branch],
      approvedCommands: [],
    };
  }
  return {
    sessionRef: msg.shiftId,
    shiftKind: 'devops',
    protectedBranches: [msg.brief.project.workingBranch, msg.worktree?.baseBranch].filter(
      (b): b is string => !!b,
    ),
    approvedCommands: msg.devops?.approval?.commands ?? [],
    // T10: the switches the owner turned off are enforced by the guard (the access is already narrowed by policy.json)
    ...(msg.devops?.access
      ? {
          access: {
            allowInstall: msg.devops.access.allowInstall,
            allowDocker: msg.devops.access.allowDocker,
            allowedPaths: msg.devops.access.allowedPaths,
          },
        }
      : {}),
    // T7: a working-branch conflict request may not change the working branch at all (the runner moves it)
    ...(msg.devops?.conflictRepo?.workingBranch
      ? { frozenBranches: [msg.devops.conflictRepo.workingBranch] }
      : {}),
    ...(isReadOnlyScan(msg) ? { readOnlyScan: true as const } : {}),
    ...appRepoGuard(msg, identityEmail),
  };
}

/** A "Scan with DevOps" request: read-only, at the guard and at the runner's IPC boundary (T3). */
export const isReadOnlyScan = (msg: ShiftStartMsg): boolean =>
  msg.kind === 'devops' && !!(msg.devops?.scan || msg.devops?.scanKind);

/**
 * The runner verbs a read-only scan may call (T3): the same set the guard's `AOM_SPECS` lets its shell run
 * (`aom setup propose`, `aom deploy probe|status`), plus the guard hook's own audit. Anything else (`toolchain.add`,
 * `git.push`, `hygiene.run`, ...) is refused at the supervisor, whatever the shell did to reach it.
 */
export const SCAN_RPC_ALLOWED: ReadonlySet<string> = new Set([
  'setup.propose',
  'deploy.probe',
  'deploy.status',
  'devops.audit',
]);

/** The app repositories of a DevOps shift's plan for the guard (no secret); nothing when no repository is on an app. */
function appRepoGuard(
  msg: ShiftStartMsg,
  identityEmail: string | null | undefined,
): Pick<DevopsGuardInput, 'appRepos' | 'identityEmail'> {
  const appRepos = (msg.postAs?.repos ?? []).flatMap((e) =>
    e.source === 'app' && e.app
      ? [{ remote: e.remoteUrlNormalized, label: e.app.label, botEmail: e.app.botEmail }]
      : [],
  );
  if (appRepos.length === 0) return {};
  return { appRepos, ...(identityEmail ? { identityEmail } : {}) };
}

/** The one shift-kind decision of the guard: DevOps requests and release prep tasks of a DevOps agent. */
export const guardedShift = (msg: ShiftStartMsg): boolean =>
  !!msg.agent.isDevops && (msg.kind === 'devops' || msg.kind === 'release_prep');

/** A BA task shift (phases): a report, briefs or a custom follow-up for the manager's phase; no card, no worktree. */
export const baTaskOf = (msg: ShiftStartMsg): BaTaskShift | undefined =>
  msg.kind === 'ba_task' ? msg.baTask : undefined;

/** A CEO shift (a wake or the daily review): no card, no worktree; the brief is rendered by the server. */
export const ceoOf = (msg: ShiftStartMsg): CeoShift | undefined => (msg.kind === 'ceo' ? msg.ceo : undefined);

/** A question shift answers one desk item (M7): no worktree, the brief is the card the question is about. */
export const questionOf = (msg: ShiftStartMsg): QuestionShift | undefined =>
  msg.kind === 'question' ? msg.question : undefined;

/** The instructions file and the prompt of a shift (DevOps request, question or card), from the (vault-enriched) brief. */
export function shiftTexts(msg: ShiftStartMsg, brief: ShiftBrief): { instructions: string; prompt: string } {
  const { instructions, prompt } = rawShiftTexts(msg, brief);
  // Sections of the role text this kind of shift never uses (the BA's intake chat in a background shift) stay out.
  return {
    instructions: dropSections(
      instructions,
      roleSectionsToDrop(brief.role.key, msg.kind, { batchIntake: !!baTaskOf(msg)?.batch }),
    ),
    prompt,
  };
}

function rawShiftTexts(msg: ShiftStartMsg, brief: ShiftBrief): { instructions: string; prompt: string } {
  const devops = devopsOf(msg);
  if (devops) {
    return { instructions: renderDevopsInstructions(brief, devops), prompt: renderDevopsPrompt(devops) };
  }
  const ceo = ceoOf(msg);
  if (ceo) return { instructions: renderCeoInstructions(brief, ceo), prompt: renderCeoPrompt(ceo) };
  const baTask = baTaskOf(msg);
  if (baTask) {
    return { instructions: renderBaTaskInstructions(brief, baTask), prompt: renderBaTaskPrompt(baTask) };
  }
  if (msg.kind === 'release_prep' && msg.releasePrep)
    return {
      instructions: renderReleasePrepInstructions(brief.agent, brief.project, msg.releasePrep),
      prompt: renderReleasePrepPrompt(msg.releasePrep),
    };
  const question = questionOf(msg);
  if (question) {
    return {
      instructions: renderQuestionInstructions(brief, question),
      prompt: renderQuestionPrompt(brief, question),
    };
  }
  // Card agents learn how to ask the DevOps engineer (`aom devops`); the section is runner-side by design. It is the
  // same for every card shift, so it goes before the stage-specific "How to report" (cache-friendly order).
  const rendered = renderInstructions(brief);
  const at = rendered.indexOf('# How to report');
  return {
    instructions:
      at >= 0
        ? `${rendered.slice(0, at)}${ENVIRONMENT_HELP_SECTION.trim()}\n\n${rendered.slice(at)}`
        : `${rendered}\n${ENVIRONMENT_HELP_SECTION}`,
    prompt: renderShiftPrompt(brief),
  };
}

/** What `aom card --json` returns: the brief, plus the request of a DevOps shift, the question of a question shift or the BA's task. */
export const cardPayload = (
  msg: ShiftStartMsg,
): ShiftBrief & { devops?: DevopsShift; question?: QuestionShift; baTask?: BaTaskShift } => {
  const devops = devopsOf(msg);
  if (devops) return { ...msg.brief, devops };
  const ceo = ceoOf(msg);
  if (ceo) return msg.brief;
  const baTask = baTaskOf(msg);
  if (baTask) return { ...msg.brief, baTask };
  const question = questionOf(msg);
  return question ? { ...msg.brief, question } : msg.brief;
};
