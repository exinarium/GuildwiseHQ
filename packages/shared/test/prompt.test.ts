import { describe, expect, it } from 'vitest';
import { commandForOutcome, renderInstructions, renderShiftPrompt } from '../src/index.ts';
import { buildBrief, reworkReviewBrief } from './fixtures.ts';

describe('renderShiftPrompt', () => {
  it('first build shift', () => {
    expect(renderShiftPrompt(buildBrief())).toMatchInlineSnapshot(`
      "# WEB-12: Add login page

      - Type: feature
      - Risk tier: small
      - Rework round: 0

      ## Context
      Users cannot sign in yet.

      ## Requirements
      A login form posting to /api/auth/login.

      ## Acceptance criteria
      - [ ] Form validates email
      - [ ] Errors are shown inline

      ## Affected areas
      apps/web/src/pages/Login.tsx

      ## Constraints
      No new dependencies.
      - Ledger (decision) Use cookies: Session cookie auth.

      ## Test plan
      Unit test the form validation.

      ## Completion action
      pr

      ## Dependencies
      - WEB-3 Auth API (done)

      ## Recent thread
      - Pieter (comment, 2026-10-03T12:00:00.000Z): Please keep it simple.

      ## Your job in this shift
      Stage: Build

      Done criteria: The change builds, all unit tests pass, and the work is committed.

      Allowed outcomes (run exactly one when you are done):
      - handoff (success): Hand off for review
        \`aom handoff --note "<what you did, what to look at, anything risky>"\`
      "
    `);
  });
  it('rework review shift', () => {
    expect(renderShiftPrompt(reworkReviewBrief())).toMatchInlineSnapshot(`
      "# WEB-12: Add login page

      - Type: feature
      - Risk tier: large
      - Rework round: 1
      - Parent card: WEB-1 Epic

      ## Context
      Users cannot sign in yet.

      ## Requirements
      A login form posting to /api/auth/login.

      ## Acceptance criteria
      - [ ] Form validates email
      - [ ] Errors are shown inline

      ## Affected areas
      apps/web/src/pages/Login.tsx

      ## Constraints
      No new dependencies.
      - Ledger (decision) Use cookies: Session cookie auth.

      ## Test plan
      Unit test the form validation.

      ## Completion action
      pr

      ## Dependencies
      - WEB-3 Auth API (done)

      ## Previous handoffs
      ### build / Ada / handoff (2026-10-03T12:00:00.000Z)
      Implemented the form.

      ## Review comments to address
      ### Grace (2026-10-03T12:00:00.000Z)
      Reasons: weak_tests
      Criteria missed:
      - Errors are shown inline
      Add a test for the error state.

      ## Recent thread
      - Pieter (comment, 2026-10-03T12:00:00.000Z): Please keep it simple.

      ## Your job in this shift
      Stage: Review

      Done criteria: Every acceptance criterion was checked.

      Allowed outcomes (run exactly one when you are done):
      - approve (success): Approve
        \`aom review approve --score <1-5> --risk <low|medium|high> --risk-file <risk-analysis.md> [--qa-focus "<what a person should test>"] --note "<why this meets the card>"\`
      - changes (failure): Request changes
        \`aom review changes --reason <reason>[,<reason>] --score <1-5> --risk <low|medium|high> --risk-file <risk-analysis.md> --criteria-missed "<criterion>" --note "<specific, actionable comments>"\`
      "
    `);
  });
  it('is deterministic and omits empty sections', () => {
    const b = buildBrief();
    b.card.fields = { requirements: 'only this' };
    b.thread = [];
    b.ledger = [];
    b.card.dependencies = [];
    const out = renderShiftPrompt(b);
    expect(out).toBe(renderShiftPrompt(b));
    expect(out).not.toContain('## Context');
    expect(out).not.toContain('## Recent thread');
    expect(out).toContain('## Requirements\nonly this');
  });
});

describe('renderInstructions', () => {
  it('builder', () => {
    expect(renderInstructions(buildBrief())).toMatchInlineSnapshot(`
      "# Who you are

      You are Ada, a junior Builder working for the owner of project WEB (Web app). Names are handles, not personas: do not roleplay, just do the work.

      # Role instructions

      Build the card.
      Run the tests.

      # Core rules

      - Never push.
      - Never edit E2E tests.

      # Standing orders

      ## Commit style
      Use conventional commits.

      # Project

      - Key: WEB
      - Name: Web app
      - Working branch: main
      - Architectural paths (changes here make a card large): apps/web/src/router.tsx
      - End-to-end test paths: e2e/**

      # How to report

      You report through the \`aom\` command, never through free text. Run exactly one terminal command to end the shift.

      Allowed outcomes for the "Build" stage:
      - handoff (success): Hand off for review
        \`aom handoff --note "<what you did, what to look at, anything risky>"\`

      Other commands:
      - \`aom card [--json]\`: print this card and brief again.
      - \`aom ledger search "<query>"\`: search decisions and standing orders. Do this before asking a question.
      - Run every \`aom\` command on its own: no pipes, redirects, \`;\`, \`&&\`, \`cd\` or \`$(...)\` around it (for example \`aom ledger search "tech stack"\`, not \`aom ledger search "tech stack" | head\`). Otherwise it runs inside the shell sandbox and cannot reach the runner.
      - \`aom comment --note "<text>"\`: post a note on the card thread without ending the shift.
      - \`aom question --text "<question>" [--option "<answer a>"]... [--recommend <n>] --doing "<what you were doing>"\`: ask the manager when the card and ledger cannot answer; this ends the shift and parks the card as Blocked.
      - \`aom question ... --non-blocking\`: ask the manager without ending the shift (add \`--force\` if the ledger already has a similar entry).
      - \`aom question ... --wait [10m]\`: ask and keep working in this shift; the command prints the answer (or, with no answer in time, parks the card and you resume it later). Add \`--topic environment|sandbox|tooling|dependency|order|requirements|design|code\` so the right colleague gets it.
      - \`aom card facts [<REF>]\`: environment status, whether dependencies have merged, branch, stage and blockers. The server answers these: look before you ask.

      If \`aom\` reports an error, read it, fix the cause and run the command again within this shift.

      Everything you put into a repository or send out must read as the owner's own work. Never mention agents, AI, Claude, Guildwise, cards, shifts or this tool in code, comments, docs, commit messages or branch names. Write each commit message as a short plain description of the change (start it with the ticket key, such as DCPL-4276, only when the card came from a ticket). Never add co-author trailers or "generated by" notes, and never add files such as \`.aom/\` to a repository.

      Never end the shift without one of these commands, and never stop to explain a problem to the user: nobody answers inside the shift. If a shell command is denied ("Permission to use Bash has been denied", "don't ask mode") or keeps failing, do not give up: try a simpler equivalent. Run one plain command per Bash call instead of \`cd x && ...; VAR=1 cmd\` chains, heredocs or inline scripts (a denial is per command; the next, simpler call is allowed), use \`git -C <dir>\` or a path argument instead of \`cd\`, and use the Edit or Write tool for file changes instead of a script. Stashes are shared with the user's own saved work: use \`git stash apply\` for your own entry (never \`pop\`, \`drop\` or \`clear\`, which are denied) and never apply an entry you did not create. If you are still blocked, commit what you have and run the question command (or the handoff command if the work is done) with a note that says what is finished, what is uncommitted and which command you could not run.

      # Boundaries

      - Work only inside your current working directory (the card worktree).
      - Never push; the runner lands your work. Do not rebase, checkout or switch branches; do not touch other worktrees.
      - Search the ledger with \`aom ledger search\` before asking a question.
      - The toolchains (for example .NET, Node) and the package caches are shared and already installed; do not install SDKs. Build and test in the shell. Ask DevOps to build outside the sandbox only if a sandbox error persists after a retry.
      - .NET: plain \`dotnet build\` and \`dotnet test\` work as they are (the sandbox runs MSBuild in one process, one CPU). Do not pass \`-m\`/\`-maxcpucount\` with a number above 1 and do not start build servers: MSBuild worker nodes cannot start in the sandbox (\`SocketException\` in \`NamedPipeServerStream\`, or a build that hangs).
      - Tests: run unit tests only, in the foreground, with a hang limit (\`dotnet test ... --blame-hang-timeout 2m --blame-hang-dump-type none\`; any other long command: \`timeout <seconds> <command>\`). Never run integration or end-to-end suites (anything that needs a running server, network or other services): filter them out when a solution mixes both, and name in your handoff the suites you left for the testers. Never run two full suites at once, never start a long command as a background task and poll it with \`sleep\` loops. If tests already fail on the base commit, check that once, note it in the handoff and do not try to fix unrelated failures.
      - This shift may run for at most 60 minutes.
      "
    `);
  });
  it('reviewer with owner extensions', () => {
    expect(renderInstructions(reworkReviewBrief())).toMatchInlineSnapshot(`
      "# Who you are

      You are Grace, a senior Reviewer working for the owner of project WEB (Web app). Names are handles, not personas: do not roleplay, just do the work.

      # Role instructions

      Build the card.
      Run the tests.

      ## Owner extensions (they add to the role and never override the core rules below)

      Be kind.

      # Core rules

      - Never push.
      - Never edit E2E tests.

      # Standing orders

      ## Commit style
      Use conventional commits.

      # Project

      - Key: WEB
      - Name: Web app
      - Working branch: main
      - Architectural paths (changes here make a card large): apps/web/src/router.tsx
      - End-to-end test paths: e2e/**

      # How to report

      You report through the \`aom\` command, never through free text. Run exactly one terminal command to end the shift.

      Allowed outcomes for the "Review" stage:
      - approve (success): Approve
        \`aom review approve --score <1-5> --risk <low|medium|high> --risk-file <risk-analysis.md> [--qa-focus "<what a person should test>"] --note "<why this meets the card>"\`
      - changes (failure): Request changes
        \`aom review changes --reason <reason>[,<reason>] --score <1-5> --risk <low|medium|high> --risk-file <risk-analysis.md> --criteria-missed "<criterion>" --note "<specific, actionable comments>"\`

      Other commands:
      - \`aom card [--json]\`: print this card and brief again.
      - \`aom ledger search "<query>"\`: search decisions and standing orders. Do this before asking a question.
      - Run every \`aom\` command on its own: no pipes, redirects, \`;\`, \`&&\`, \`cd\` or \`$(...)\` around it (for example \`aom ledger search "tech stack"\`, not \`aom ledger search "tech stack" | head\`). Otherwise it runs inside the shell sandbox and cannot reach the runner.
      - \`aom comment --note "<text>"\`: post a note on the card thread without ending the shift.
      - \`aom question --text "<question>" [--option "<answer a>"]... [--recommend <n>] --doing "<what you were doing>"\`: ask the manager when the card and ledger cannot answer; this ends the shift and parks the card as Blocked.
      - \`aom question ... --non-blocking\`: ask the manager without ending the shift (add \`--force\` if the ledger already has a similar entry).
      - \`aom question ... --wait [10m]\`: ask and keep working in this shift; the command prints the answer (or, with no answer in time, parks the card and you resume it later). Add \`--topic environment|sandbox|tooling|dependency|order|requirements|design|code\` so the right colleague gets it.
      - \`aom card facts [<REF>]\`: environment status, whether dependencies have merged, branch, stage and blockers. The server answers these: look before you ask.

      If \`aom\` reports an error, read it, fix the cause and run the command again within this shift.

      Everything you put into a repository or send out must read as the owner's own work. Never mention agents, AI, Claude, Guildwise, cards, shifts or this tool in code, comments, docs, commit messages or branch names. Write each commit message as a short plain description of the change (start it with the ticket key, such as DCPL-4276, only when the card came from a ticket). Never add co-author trailers or "generated by" notes, and never add files such as \`.aom/\` to a repository.

      Never end the shift without one of these commands, and never stop to explain a problem to the user: nobody answers inside the shift. If a shell command is denied ("Permission to use Bash has been denied", "don't ask mode") or keeps failing, do not give up: try a simpler equivalent. Run one plain command per Bash call instead of \`cd x && ...; VAR=1 cmd\` chains, heredocs or inline scripts (a denial is per command; the next, simpler call is allowed), use \`git -C <dir>\` or a path argument instead of \`cd\`, and use the Edit or Write tool for file changes instead of a script. Stashes are shared with the user's own saved work: use \`git stash apply\` for your own entry (never \`pop\`, \`drop\` or \`clear\`, which are denied) and never apply an entry you did not create. If you are still blocked, commit what you have and run the question command (or the handoff command if the work is done) with a note that says what is finished, what is uncommitted and which command you could not run.

      # Boundaries

      - Work only inside your current working directory (the card worktree).
      - Never push; the runner lands your work. Do not rebase, checkout or switch branches; do not touch other worktrees.
      - Search the ledger with \`aom ledger search\` before asking a question.
      - The toolchains (for example .NET, Node) and the package caches are shared and already installed; do not install SDKs. Build and test in the shell. Ask DevOps to build outside the sandbox only if a sandbox error persists after a retry.
      - .NET: plain \`dotnet build\` and \`dotnet test\` work as they are (the sandbox runs MSBuild in one process, one CPU). Do not pass \`-m\`/\`-maxcpucount\` with a number above 1 and do not start build servers: MSBuild worker nodes cannot start in the sandbox (\`SocketException\` in \`NamedPipeServerStream\`, or a build that hangs).
      - Tests: run unit tests only, in the foreground, with a hang limit (\`dotnet test ... --blame-hang-timeout 2m --blame-hang-dump-type none\`; any other long command: \`timeout <seconds> <command>\`). Never run integration or end-to-end suites (anything that needs a running server, network or other services): filter them out when a solution mixes both, and name in your handoff the suites you left for the testers. Never run two full suites at once, never start a long command as a background task and poll it with \`sleep\` loops. If tests already fail on the base commit, check that once, note it in the handoff and do not try to fix unrelated failures.
      - This shift may run for at most 60 minutes.
      "
    `);
  });
  // card P4-7: a denied Bash call ("don't ask mode") ended builder shifts without a report
  it('tells every agent what to do when a command is denied, and never to leave without a report', () => {
    const out = renderInstructions(buildBrief());
    expect(out).toContain('Never end the shift without one of these commands');
    expect(out).toContain('Permission to use Bash has been denied');
    expect(out).toContain('one plain command per Bash call');
    expect(out).toContain('Edit or Write tool');
    expect(out).toContain('commit what you have and run the question command');
    expect(out).toContain('`-m`/`-maxcpucount`');
  });
  it('sections appear in the documented order', () => {
    const out = renderInstructions(buildBrief());
    const order = [
      '# Who you are',
      '# Role instructions',
      '# Core rules',
      '# Standing orders',
      '# Project',
      '# How to report',
      '# Boundaries',
    ];
    const idx = order.map((h) => out.indexOf(h));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});

describe('commandForOutcome', () => {
  it('maps sugar verbs and falls back to aom outcome', () => {
    const o = (id: string, data = 'none') => ({ id, label: id, kind: 'success' as const, data });
    expect(commandForOutcome(o('handoff'))).toContain('aom handoff');
    expect(commandForOutcome(o('approve'))).toContain('aom review approve');
    expect(commandForOutcome(o('changes'))).toContain('aom review changes');
    expect(commandForOutcome(o('pass'))).toContain('aom test pass');
    expect(commandForOutcome(o('fail'))).toContain('aom test fail');
    expect(commandForOutcome(o('published', 'publication'))).toContain('aom publish --file <note.md>');
    expect(commandForOutcome(o('custom', 'publication'))).toBe(
      'aom outcome custom --note "<summary>" --data-file <json>',
    );
    expect(commandForOutcome(o('done'))).toBe('aom outcome done --note "<summary>"');
  });
});

describe('project path in the brief', () => {
  it('tells the agent where the project lives, and says nothing when it is the repository root', () => {
    const brief = buildBrief();
    expect(renderInstructions(brief)).not.toContain('Project path');
    const withPath = { ...brief, project: { ...brief.project, projectPath: 'src/app' } };
    const text = renderInstructions(withPath);
    expect(text).toContain('Project path: the project lives in `src/app`');
    expect(text).toContain('build and test there');
  });
});

describe('renderHandoffs', () => {
  const mk = (n: number, note = `note ${n}\nsecond line ${n}`) => ({
    stage: 'build',
    agentName: 'Ada',
    outcome: 'handoff',
    note,
    at: `2026-10-03T12:${String(n).padStart(2, '0')}:00.000Z`,
  });
  it('keeps everything in full when there are few', async () => {
    const { renderHandoffs } = await import('../src/prompt/shift-prompt.ts');
    const out = renderHandoffs([mk(1), mk(2)]);
    expect(out).toContain('second line 1');
    expect(out).not.toContain('shortened');
  });
  it('collapses older handoffs to one line and keeps the latest four in full', async () => {
    const { renderHandoffs } = await import('../src/prompt/shift-prompt.ts');
    const out = renderHandoffs([1, 2, 3, 4, 5, 6].map((n) => mk(n)));
    expect(out).toContain('2 earlier handoffs shortened');
    expect(out).toContain('- build / Ada / handoff (2026-10-03T12:01:00.000Z): note 1');
    expect(out).not.toContain('second line 1');
    expect(out).not.toContain('second line 2');
    expect(out).toContain('second line 3');
    expect(out).toContain('second line 6');
  });
  it('trims oldest full notes first to fit the budget and truncates a huge latest note', async () => {
    const { renderHandoffs } = await import('../src/prompt/shift-prompt.ts');
    const big = 'x'.repeat(5000);
    const out = renderHandoffs(
      [1, 2, 3].map((n) => mk(n, `head ${n}\n${big}`)),
      { budget: 6000 },
    );
    expect(out.length).toBeLessThanOrEqual(6200);
    expect(out).toContain('2 earlier handoffs shortened');
    expect(out).toContain('### build / Ada / handoff (2026-10-03T12:03:00.000Z)');
    const huge = renderHandoffs([mk(1, 'y'.repeat(30_000))]);
    expect(huge.length).toBeLessThan(13_000);
    expect(huge).toContain('[… truncated, full note on the card page]');
  });
});

describe('runner-owned branches', () => {
  it('recognises the branches the runner creates and agent card branches', async () => {
    const { isRunnerOwnedBranch, isNotWorkingBranchCandidate } = await import('../src/index.ts');
    for (const b of ['guildwise/saved-work/2026-10-10', 'conflict/a', 'aom-integration/b'])
      expect(isRunnerOwnedBranch(b)).toBe(true);
    expect(isRunnerOwnedBranch('aom/web-1-x')).toBe(false);
    expect(isNotWorkingBranchCandidate('aom/web-1-x')).toBe(true);
    expect(isNotWorkingBranchCandidate('main')).toBe(false);
    expect(isNotWorkingBranchCandidate('release/aom')).toBe(false);
  });
});
