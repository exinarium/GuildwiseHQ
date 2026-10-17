import { type WorkflowDefinition, WorkflowDefinitionSchema } from '../schema.ts';

const BUILD_REQUIRED = [
  'title',
  'cardType',
  'context',
  'requirements',
  'acceptanceCriteria',
  'affectedAreas',
  'constraints',
  'testPlan',
  'completionAction',
  'repoId',
];

/**
 * code-v6, the lean team workflow (Lean Team v3, docs/design: card flow). A new built-in workflow of its own (key
 * `code-v6`), so every project, card and replayed event on `code` v1 to v5 keeps working unchanged: new projects start on
 * it and an existing project opts in (`POST /api/projects/:id/upgrade-workflow`); cards in flight keep the version they
 * are pinned to.
 *
 *   Spec -> Planning (planner, Haiku) -> Design (architect, Opus; on for every card) -> Build (builder; carries build and
 *   unit test evidence) -> Pre-review (Sonnet) -> Review (Opus, read-only; a second Opus approval for a high-risk change)
 *   -> Owner approval (large or high-risk cards; bound to the reviewed commit) -> Test deploy (the server starts the test
 *   environment for the reviewed commit, no agent) -> Test (area E2E on that environment) -> Docs -> Finalize
 *   -> QA steps -> Manual QA -> Done.
 *
 * `merge_review` is not on the main path: the server sends a card there when DevOps resolved a merge conflict that did not
 * touch reviewed lines (the earlier approvals stay; the reviewer looks at the resolution only).
 */
export const codeWorkflowV6: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  key: 'code-v6',
  version: 1,
  name: 'Code (lean team)',
  department: 'delivery',
  builtIn: true,
  fieldSet: 'code',
  cardTypes: ['feature', 'bug', 'support', 'refactor', 'docs', 'regression'],
  initialStage: 'spec',
  // Every card is designed (on Opus), also a small one: the card's own switch can still turn it off.
  defaults: { designNeeded: true },
  stages: [
    {
      id: 'spec',
      label: 'Spec',
      column: 'Spec',
      kind: 'manual',
      claimRole: null,
      requiredFields: ['title', 'cardType'],
      doneCriteria: 'The card is fully specified and moved on by the manager or the BA.',
      outcomes: [
        { id: 'specified', label: 'Specified', kind: 'success', to: 'planning', event: 'CardSpecified' },
      ],
    },
    {
      id: 'planning',
      label: 'Planning',
      column: 'Planning',
      kind: 'agent',
      claimRole: 'planner',
      // Without a hired planner the architect plans (and designs) the card.
      fallbackRole: 'architect',
      requiredFields: ['title', 'cardType', 'context', 'requirements', 'repoId'],
      doneCriteria:
        'The areas and files the card touches, the relevant documentation and likely overlaps with other cards are written up as a planning note; related cards share a group id and the order between cards is recorded.',
      outcomes: [
        {
          id: 'planned',
          label: 'Hand the planning note to the architect',
          kind: 'success',
          to: 'investigate',
          event: 'StageCompleted',
        },
      ],
      // Planning reads the code (a read-only checkout) and the project documents; it has no worktree of its own.
      worktree: 'none',
      maxShiftMinutes: 30,
    },
    {
      id: 'investigate',
      label: 'Investigate & design',
      column: 'Design',
      kind: 'agent',
      claimRole: 'architect',
      seniorOnly: true,
      requiredFields: ['title', 'cardType', 'context', 'requirements', 'repoId'],
      doneCriteria:
        'The question is investigated, the report (investigation or design) is written to the report path and committed on the card branch, a short Card Brief for the builder is recorded and the result is handed on.',
      outcomes: [
        {
          id: 'handoff',
          label: 'Hand off the design to build',
          kind: 'success',
          to: 'build',
          event: 'StageCompleted',
          data: 'investigation',
          when: { field: 'investigationOnly', equals: false },
        },
        {
          id: 'report',
          label: 'Report the investigation',
          kind: 'success',
          to: 'finalize',
          event: 'StageCompleted',
          data: 'investigation',
          when: { field: 'investigationOnly', equals: true },
        },
      ],
      when: { field: 'designNeeded', equals: true },
      worktree: 'create',
      syncMainBefore: true,
      maxShiftMinutes: 90,
    },
    {
      id: 'build',
      label: 'Build',
      column: 'In progress',
      kind: 'agent',
      claimRole: 'builder',
      requiredFields: BUILD_REQUIRED,
      doneCriteria:
        'The change builds, all unit tests pass, unit tests were written for the change, the work is committed on the card branch and the handoff carries the build and unit test evidence.',
      outcomes: [
        {
          id: 'handoff',
          label: 'Hand off for review',
          kind: 'success',
          to: 'pre_review',
          event: 'ReviewRequested',
          data: 'buildHandoff',
        },
      ],
      worktree: 'create',
      syncMainBefore: true,
      requireBuildEvidence: true,
    },
    {
      id: 'pre_review',
      label: 'Pre-review',
      column: 'Review',
      kind: 'agent',
      claimRole: 'pre_reviewer',
      // Without a hired pre-reviewer the reviewer does this pass too.
      fallbackRole: 'reviewer',
      doneCriteria:
        'The diff was read for obvious bugs, rule and checklist violations, missing tests and code smells; the findings go back to the builder, or the card goes on to the Opus review.',
      outcomes: [
        {
          id: 'approve',
          label: 'Nothing to fix: on to the Opus review',
          kind: 'success',
          to: 'review',
          event: 'StageCompleted',
          data: 'review',
        },
        {
          id: 'changes',
          label: 'Send the findings back to the builder',
          kind: 'failure',
          to: 'build',
          event: 'ChangesRequested',
          data: 'review',
          rework: true,
        },
      ],
      worktree: 'reuse',
      // The review (and this pass) sees what will merge: the card branch is rebased on its base first.
      rebaseBefore: true,
      maxShiftMinutes: 30,
    },
    {
      id: 'review',
      label: 'Review',
      column: 'Review',
      kind: 'agent',
      claimRole: 'reviewer',
      seniorOnly: true,
      doneCriteria:
        'The diff and the code were read critically from several perspectives (no build, no tests); every acceptance criterion was checked against the diff; the verdict, score and risk are recorded.',
      outcomes: [
        {
          id: 'approve',
          label: 'Approve',
          kind: 'success',
          to: 'owner_approval',
          event: 'ReviewApproved',
          data: 'review',
        },
        {
          id: 'changes',
          label: 'Request changes',
          kind: 'failure',
          to: 'build',
          event: 'ChangesRequested',
          data: 'review',
          rework: true,
        },
      ],
      worktree: 'reuse',
      rebaseBefore: true,
      // One Opus approval for every card; the server asks for a second one when the change is high risk.
      approvals: { small: 1, large: 1 },
    },
    {
      id: 'merge_review',
      label: 'Merge review',
      column: 'Review',
      kind: 'agent',
      claimRole: 'reviewer',
      seniorOnly: true,
      doneCriteria:
        'The merge conflict resolution (the diff between the reviewed commit and the resolved one) was read: both sides kept their intent and nothing else changed. The earlier approvals stand.',
      outcomes: [
        {
          id: 'approve',
          label: 'The resolution is right: back to test',
          kind: 'success',
          to: 'test_deploy',
          event: 'StageCompleted',
          data: 'review',
        },
        {
          id: 'changes',
          label: 'Request changes',
          kind: 'failure',
          to: 'build',
          event: 'ChangesRequested',
          data: 'review',
          rework: true,
        },
      ],
      worktree: 'reuse',
      maxShiftMinutes: 30,
    },
    {
      id: 'owner_approval',
      label: 'Owner approval',
      column: 'Approval',
      kind: 'human',
      human: { purpose: 'approval', approver: { kind: 'project_owner' } },
      claimRole: null,
      doneCriteria:
        'The project owner read the final diff, the design note and the review verdict and approved this commit, or sent the card back with a comment.',
      outcomes: [
        { id: 'approve', label: 'Approve', kind: 'success', to: 'test_deploy', event: 'StageCompleted' },
        {
          id: 'send_back',
          label: 'Send back',
          kind: 'failure',
          to: 'build',
          event: 'StageCompleted',
          rework: true,
        },
      ],
      // Decided by the server when the last review approval comes in (policy, size, high risk): a small low-risk card skips it.
      when: { field: 'ownerApproval', equals: true },
    },
    {
      id: 'test_deploy',
      label: 'Test deploy',
      column: 'Test',
      kind: 'server',
      server: { action: 'test_deploy' },
      claimRole: null,
      doneCriteria:
        'The server started the test environment for the reviewed commit and it is healthy at that commit. No agent works here; DevOps steps in only when the start fails.',
      outcomes: [
        { id: 'ready', label: 'Environment ready', kind: 'success', to: 'test', event: 'StageCompleted' },
      ],
      environment: 'project',
    },
    {
      id: 'test',
      label: 'Test',
      column: 'Test',
      kind: 'agent',
      claimRole: 'tester',
      doneCriteria:
        'The E2E tests of the areas this card touches were run against the test environment of the reviewed commit; evidence of the result is recorded.',
      outcomes: [
        {
          id: 'pass',
          label: 'Tests pass',
          kind: 'success',
          to: 'docs',
          event: 'TestPassed',
          data: 'testEvidence',
        },
        {
          id: 'fail',
          label: 'Tests fail',
          kind: 'failure',
          to: 'test',
          event: 'TestFailed',
          data: 'testEvidence',
          effect: 'spawn_bug_child',
        },
      ],
      worktree: 'reuse',
      // The reviewed commit is the tested commit: no rebase here.
      rebaseBefore: false,
      requiredCapabilities: ['shell'],
      environment: 'project',
      envStrict: true,
      maxShiftMinutes: 120,
    },
    {
      id: 'docs',
      label: 'Docs',
      column: 'Docs',
      kind: 'agent',
      claimRole: 'writer',
      doneCriteria: 'Documentation reflects the change and is committed.',
      outcomes: [
        { id: 'done', label: 'Docs done', kind: 'success', to: 'finalize', event: 'StageCompleted' },
      ],
      when: { field: 'docsNeeded', equals: true },
      worktree: 'reuse',
    },
    {
      id: 'finalize',
      label: 'Finalize',
      column: 'Finalize',
      kind: 'agent',
      claimRole: 'ba',
      seniorOnly: true,
      doneCriteria: 'The completion action (PR, push or merge) was executed and its result recorded.',
      outcomes: [
        {
          id: 'finalized',
          label: 'Finalized',
          kind: 'success',
          to: 'qa_steps',
          event: 'CardFinalized',
          data: 'finalize',
          effect: 'finalize',
        },
        // Never offered to the BA (`mergeReview` is derived and false): the server moves a card here when DevOps resolved a
        // merge conflict at Finalize (see the note on `merge_review`); the route is declared so the stage graph is complete.
        {
          id: 'conflict_resolved',
          label: 'Merge conflict resolved: merge review',
          kind: 'failure',
          to: 'merge_review',
          event: 'StageCompleted',
          when: { field: 'mergeReview', equals: true },
        },
      ],
      worktree: 'reuse',
      rebaseBefore: false,
    },
    {
      id: 'qa_steps',
      label: 'QA steps',
      column: 'QA',
      kind: 'agent',
      claimRole: 'tester',
      fallbackRole: 'ba',
      doneCriteria:
        'Write the manual test steps for the person who will test this card, from the card (context, requirements, acceptance criteria, test plan), the review and test handoffs and what changed. Group them by scenario: happy path, edge cases, error handling, regressions, UI and data checks. Each step is a markdown checkbox ("- [ ] ...") that says what to do and what to expect. Read-only: do not change code or files and do not run the project. Post the steps with `aom outcome steps --note-file <steps.md>`.',
      outcomes: [
        {
          id: 'steps',
          label: 'Post the QA steps',
          kind: 'success',
          to: 'manual_qa',
          event: 'StageCompleted',
        },
      ],
      when: { field: 'qaAgent', equals: true },
      worktree: 'none',
      maxShiftMinutes: 20,
    },
    {
      id: 'manual_qa',
      label: 'Manual QA',
      column: 'QA',
      kind: 'human',
      human: { purpose: 'qa', assignee: 'starter' },
      claimRole: null,
      doneCriteria:
        'The person who started the card tested it and passed it, skipped the test, or sent it back with a comment.',
      outcomes: [
        { id: 'pass', label: 'Pass', kind: 'success', to: 'done', event: 'QaPassed' },
        { id: 'skip', label: 'Skip the test', kind: 'success', to: 'done', event: 'QaSkipped' },
        {
          id: 'send_back',
          label: 'Send back',
          kind: 'failure',
          to: 'build',
          event: 'QaSentBack',
          rework: true,
        },
      ],
      when: { field: 'manualQa', equals: true },
    },
    { id: 'done', label: 'Done', column: 'Done', kind: 'terminal', claimRole: null, doneCriteria: '' },
  ],
});
