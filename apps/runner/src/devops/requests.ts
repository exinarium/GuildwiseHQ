import {
  type DevopsShift,
  ENVIRONMENT_HELP_SECTION,
  renderDevopsInstructions,
  renderDevopsPrompt,
  renderInstructions,
  renderShiftPrompt,
  type ServerToRunnerOf,
  type ShiftBrief,
} from '@aom/shared';

type ShiftStartMsg = ServerToRunnerOf<'shift.start'>;

/** A DevOps shift works one request of this workstation's DevOps engineer; it has no card or worktree. */
export const devopsOf = (msg: ShiftStartMsg): DevopsShift | undefined =>
  msg.kind === 'devops' ? msg.devops : undefined;

/** The instructions file and the prompt of a shift (DevOps request or card), from the (vault-enriched) brief. */
export function shiftTexts(msg: ShiftStartMsg, brief: ShiftBrief): { instructions: string; prompt: string } {
  const devops = devopsOf(msg);
  if (devops) {
    return { instructions: renderDevopsInstructions(brief, devops), prompt: renderDevopsPrompt(devops) };
  }
  return {
    // Card agents learn how to ask the DevOps engineer (`aom devops`); the section is runner-side by design.
    instructions: `${renderInstructions(brief)}\n${ENVIRONMENT_HELP_SECTION}`,
    prompt: renderShiftPrompt(msg.brief),
  };
}

/** What `aom card --json` returns: the brief, plus the request for a DevOps shift. */
export const cardPayload = (msg: ShiftStartMsg): ShiftBrief & { devops?: DevopsShift } => {
  const devops = devopsOf(msg);
  return devops ? { ...msg.brief, devops } : msg.brief;
};
