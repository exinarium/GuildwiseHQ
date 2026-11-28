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
import { versionPinnedToolNames } from '../toolchain/stacks.ts';

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

// ---------------------------------------------------------------- quiet-approvals R1: the inner box

/**
 * How the runner runs a DevOps request shift (quiet-approvals R1, decided locally in `runner.ts`):
 * - `box`: inside the builder-like box, no click (every server DevOps shift starts here);
 * - `outside`: the DevOps profile as before, after a local yes, an R2 exact-job match or a C2 resume;
 * - `hygiene`: the deterministic tidy-up, no AI session at all ([B4]).
 */
export type DevopsMode = 'box' | 'outside' | 'hygiene';

/**
 * [B1] The runner verbs a DevOps shift keeps inside the box: only builder-equivalent reads, plus the two new verbs.
 * Everything else (`DEVOPS_INSTALL_RPC`, `git.*`, `toolchain.add|remove`, `hygiene.run`, `recipe.save`,
 * `deploy.probe`, `run.*`, `env.*`, `test.suite`, `runner.restart`, `ceo`, `delegate.guard`, and every server verb) is
 * refused with the way out. Placed beside T3's scan allowlist; fails closed (an unknown verb is refused).
 */
export const INSIDE_BOX_RPC: ReadonlySet<string> = new Set([
  'card.get',
  'card.attachments',
  'skill.list',
  'skill.show',
  'transcript.fetch',
  'toolchain.list',
  'devops.audit',
  'toolchain.ensure',
  'devops.outside',
]);

export const insideBoxRpc = (method: string): boolean =>
  INSIDE_BOX_RPC.has(method) || method.startsWith('graph.');

export const OUTSIDE_HINT = 'aom devops-outside --needs <what> --why <why>';

/** The one sentence a refused verb gets in the box. */
export const boxRefusal = (what: string): string =>
  `\`${what}\` needs outside the box: \`${OUTSIDE_HINT}\` (the owner says yes once on this computer).`;

/** The runner's own section for a DevOps shift inside the box (replaces nothing the server wrote; added last). */
export const DEVOPS_BOX_NOTE = `# You work inside the safety box

This request runs inside a sandbox like a builder's, without asking the owner:
- You can read the project's clones (read-only), and write only in your working folder and your scratch folder.
- You have a shell with package registries reachable, but no web tools, no Docker, no ssh keys and no publishing to a git host.
- \`aom toolchain ensure <tool>\` downloads a tool the project needs (checksum-verified), when this computer allows it.
  For a catalogued tool (${versionPinnedToolNames().join(', ')}) use it FIRST, even when the project does not use the tool:
  it needs no question. Any other download (a GitHub release, an installer script) goes to \`aom devops-outside\` at once.
- Inspections, reading logs and configuration, and preparing changes all work here.

If the request needs something the box does not allow (Docker, a deploy, git writes in a clone, publishing a branch, an
install outside your folders, a remote host), do not try to work around it. Run:

    ${OUTSIDE_HINT}

That ends this session and asks the owner once on this computer; after the yes the request continues outside the box.
Report with \`aom devops-done\`, \`aom devops-question\` and \`aom devops-comment\` as usual; \`aom devops-approval\` is not used here.`;

/** gate-fixes-1 F3: the answer to `aom devops-outside` in a request that already runs outside the box. */
export const DEVOPS_ALREADY_OUTSIDE =
  'This request already runs outside the box (approved on this computer): run the commands directly. Do not call `aom devops-outside` again.';

/**
 * gate-fixes-1 F3: the runner's own section for a DevOps request that runs outside the box (the outer box after a local yes):
 * it is already outside, and whether Docker is there (`yes`: through the runner's gatekeeper; `switch`: off by the
 * workstation's switch; otherwise the reason it cannot be reached at all).
 */
export function devopsOutsideNote(docker: 'yes' | 'switch' | string, toolchainDir?: string | null): string {
  const dockerLine =
    docker === 'yes'
      ? "- Docker: yes, through the runner's Docker gatekeeper (`DOCKER_HOST` is set; the real socket is never here)."
      : docker === 'switch'
        ? "- Docker: off by the workstation's Docker switch. A docker command is refused with the way to ask for the switch (`aom devops-approval --switch docker`); approving a single command cannot open it."
        : `- Docker: not available (${docker}). Do not ask for it; finish what works without it and say in your report what needs it.`;
  return `# You work outside the safety box

The owner said yes on this computer: this request already runs outside the box. Do not call \`aom devops-outside\`.
${dockerLine}
${
  toolchainDir
    ? `- Tools: install a downloaded tool into a NEW folder ${toolchainDir}/<tool>/<version> (GitHub's download hosts are reachable), then register it with \`aom toolchain add\`; it waits for the owner's \`toolchain approve\`. Nothing else in the Guildwise tool folder can be written, and no approval opens it.`
    : '- Tools: this computer does not let DevOps download tools into the Guildwise tool folder.'
}
Report with \`aom devops-done\`, \`aom devops-question\` and \`aom devops-comment\` as usual.`;
}
