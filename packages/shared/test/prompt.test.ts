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
        \`aom review approve --score <1-5> --note "<why this meets the card>"\`
      - changes (failure): Request changes
        \`aom review changes --reason <reason>[,<reason>] --score <1-5> --criteria-missed "<criterion>" --note "<specific, actionable comments>"\`
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
      - Domain: work
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
      - \`aom comment --note "<text>"\`: post a note on the card thread without ending the shift.
      - \`aom question --text "<question>" [--option "<answer a>"]... [--recommend <n>] --doing "<what you were doing>"\`: ask the manager when the card and ledger cannot answer; this ends the shift and parks the card as Blocked.
      - \`aom question ... --non-blocking\`: ask the manager without ending the shift (add \`--force\` if the ledger already has a similar entry).

      If \`aom\` reports an error, read it, fix the cause and run the command again within this shift.

      # Boundaries

      - Work only inside your current working directory (the card worktree).
      - Do not push, rebase, checkout or switch branches; do not touch other worktrees.
      - Search the ledger with \`aom ledger search\` before asking a question.
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

      ## Owner extensions

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
      - Domain: work
      - Working branch: main
      - Architectural paths (changes here make a card large): apps/web/src/router.tsx
      - End-to-end test paths: e2e/**

      # How to report

      You report through the \`aom\` command, never through free text. Run exactly one terminal command to end the shift.

      Allowed outcomes for the "Review" stage:
      - approve (success): Approve
        \`aom review approve --score <1-5> --note "<why this meets the card>"\`
      - changes (failure): Request changes
        \`aom review changes --reason <reason>[,<reason>] --score <1-5> --criteria-missed "<criterion>" --note "<specific, actionable comments>"\`

      Other commands:
      - \`aom card [--json]\`: print this card and brief again.
      - \`aom ledger search "<query>"\`: search decisions and standing orders. Do this before asking a question.
      - \`aom comment --note "<text>"\`: post a note on the card thread without ending the shift.
      - \`aom question --text "<question>" [--option "<answer a>"]... [--recommend <n>] --doing "<what you were doing>"\`: ask the manager when the card and ledger cannot answer; this ends the shift and parks the card as Blocked.
      - \`aom question ... --non-blocking\`: ask the manager without ending the shift (add \`--force\` if the ledger already has a similar entry).

      If \`aom\` reports an error, read it, fix the cause and run the command again within this shift.

      # Boundaries

      - Work only inside your current working directory (the card worktree).
      - Do not push, rebase, checkout or switch branches; do not touch other worktrees.
      - Search the ledger with \`aom ledger search\` before asking a question.
      - This shift may run for at most 60 minutes.
      "
    `);
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
    expect(commandForOutcome(o('published', 'publication'))).toBe(
      'aom outcome published --note "<summary>" --data-file <json>',
    );
    expect(commandForOutcome(o('done'))).toBe('aom outcome done --note "<summary>"');
  });
});
