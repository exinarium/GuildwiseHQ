import {
  type BaTaskShift,
  type DevopsShift,
  ENVIRONMENT_HELP_SECTION,
  type QuestionShift,
  renderBaTaskInstructions,
  renderBaTaskPrompt,
  renderDevopsInstructions,
  renderDevopsPrompt,
  renderInstructions,
  renderQuestionInstructions,
  renderQuestionPrompt,
  renderShiftPrompt,
  type ServerToRunnerOf,
  type ShiftBrief,
} from '@aom/shared';

type ShiftStartMsg = ServerToRunnerOf<'shift.start'>;

/** A DevOps shift works one request of this workstation's DevOps engineer; it has no card or worktree. */
export const devopsOf = (msg: ShiftStartMsg): DevopsShift | undefined =>
  msg.kind === 'devops' ? msg.devops : undefined;

/** A BA task shift (phases): a report, briefs or a custom follow-up for the manager's phase; no card, no worktree. */
export const baTaskOf = (msg: ShiftStartMsg): BaTaskShift | undefined =>
  msg.kind === 'ba_task' ? msg.baTask : undefined;

/** A question shift answers one desk item (M7): no worktree, the brief is the card the question is about. */
export const questionOf = (msg: ShiftStartMsg): QuestionShift | undefined =>
  msg.kind === 'question' ? msg.question : undefined;

/** The instructions file and the prompt of a shift (DevOps request, question or card), from the (vault-enriched) brief. */
export function shiftTexts(msg: ShiftStartMsg, brief: ShiftBrief): { instructions: string; prompt: string } {
  const devops = devopsOf(msg);
  if (devops) {
    return { instructions: renderDevopsInstructions(brief, devops), prompt: renderDevopsPrompt(devops) };
  }
  const baTask = baTaskOf(msg);
  if (baTask) {
    return { instructions: renderBaTaskInstructions(brief, baTask), prompt: renderBaTaskPrompt(baTask) };
  }
  const question = questionOf(msg);
  if (question) {
    return {
      instructions: renderQuestionInstructions(brief, question),
      prompt: renderQuestionPrompt(brief, question),
    };
  }
  return {
    // Card agents learn how to ask the DevOps engineer (`aom devops`); the section is runner-side by design.
    instructions: `${renderInstructions(brief)}\n${ENVIRONMENT_HELP_SECTION}`,
    prompt: renderShiftPrompt(brief),
  };
}

/** What `aom card --json` returns: the brief, plus the request of a DevOps shift, the question of a question shift or the BA's task. */
export const cardPayload = (
  msg: ShiftStartMsg,
): ShiftBrief & { devops?: DevopsShift; question?: QuestionShift; baTask?: BaTaskShift } => {
  const devops = devopsOf(msg);
  if (devops) return { ...msg.brief, devops };
  const baTask = baTaskOf(msg);
  if (baTask) return { ...msg.brief, baTask };
  const question = questionOf(msg);
  return question ? { ...msg.brief, question } : msg.brief;
};
