import { describe, expect, it } from 'vitest';
import {
  allowedOutcomes,
  BUILTIN_ROLES,
  codeWorkflowV1,
  codeWorkflowV2,
  commandForOutcome,
  getBuiltinRole,
  getBuiltinWorkflow,
  INVESTIGATION_DEFAULT_PATH,
  memberOutcome,
  missingForSpecify,
  outcomeDataSchema,
  phaseCompletion,
  renderInvestigationsIndex,
  renderShiftPrompt,
  repoFileUrl,
  requiredForSpecify,
  resolveOutcome,
  resolveReportTarget,
  roleClaimsStage,
  type ShiftBrief,
  scanReportForSecrets,
  validateWorkflow,
  WorkflowResolveError,
} from '../src/index.ts';

const build = [
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

describe('the architect role', () => {
  const architect = getBuiltinRole('architect');
  it('is a senior Opus role that reads the organization and writes documentation only', () => {
    expect(architect).toMatchObject({
      version: 1,
      builtIn: true,
      department: 'delivery',
      seniorityLevels: ['senior'],
      defaultModel: { runtime: 'claude-code', model: 'opus', effort: 'high' },
      claimableStages: [{ workflowKey: '*', stageId: 'investigate*' }],
    });
    expect(architect?.permissions).toMatchObject({
      readOrgRepos: true,
      mayCommit: true,
      writableGlobs: ['docs/**', '**/*.md'],
      allowedTools: ['read', 'edit', 'shell', 'web'],
    });
  });

  it('keeps raw git push, fetch, pull and remote denied (the runner does them) but not merge or commit', () => {
    const denied = architect?.permissions.deniedShellPatterns ?? [];
    for (const p of [
      'git push*',
      'git fetch*',
      'git pull*',
      'git remote*',
      'git rebase*',
      'git checkout*',
      'git switch*',
    ])
      expect(denied).toContain(p);
    expect(denied).not.toContain('git merge*');
    expect(denied).not.toContain('git commit*');
  });

  it('only the architect has readOrgRepos, and it claims every investigate* stage of any workflow', () => {
    expect(BUILTIN_ROLES.filter((r) => r.permissions.readOrgRepos).map((r) => r.key)).toEqual(['architect']);
    expect(architect && roleClaimsStage(architect, 'code', 'investigate')).toBe(true);
    expect(architect && roleClaimsStage(architect, 'anything', 'investigate_after_test')).toBe(true);
    expect(architect && roleClaimsStage(architect, 'code', 'build')).toBe(false);
  });

  it('is not added to code-bugfix', () => {
    const bugfix = getBuiltinWorkflow('code-bugfix');
    expect(bugfix?.stages.some((s) => s.claimRole === 'architect')).toBe(false);
  });

  it('the instructions give the whole recipe and the core rules the limits', () => {
    const i = architect?.instructions ?? '';
    for (const s of [
      'aom design',
      'aom investigate',
      'aom git verify-merge',
      'aom git push',
      'aom question',
      'Folders you can read'.length ? 'read the other repositories' : '',
    ])
      expect(i).toContain(s);
    expect(architect?.coreRules.join('\n')).toMatch(/never push/i);
    expect(architect?.coreRules.join('\n')).toMatch(/secrets/i);
  });

  it('the BA v10 instructions cover the intake flags and the investigation-only finalize; the builder reads the design', () => {
    const ba = getBuiltinRole('ba');
    expect(ba?.version).toBe(10);
    for (const s of [
      'designNeeded',
      'investigationOnly',
      'mergeMainFirst',
      'aom investigation record',
      '--action none',
    ])
      expect(ba?.instructions).toContain(s);
    const builder = getBuiltinRole('builder');
    expect(builder?.version).toBe(3);
    expect(builder?.instructions).toMatch(/design report/i);
  });
});

describe('code workflow v2', () => {
  it('is valid, keeps v1 and is the newest', () => {
    expect(validateWorkflow(codeWorkflowV2, BUILTIN_ROLES)).toEqual([]);
    expect(validateWorkflow(codeWorkflowV1, BUILTIN_ROLES)).toEqual([]);
    expect(getBuiltinWorkflow('code')).toBe(codeWorkflowV2);
    expect(codeWorkflowV2.stages.map((s) => s.id)).toEqual([
      'spec',
      'investigate',
      'build',
      'review',
      'test',
      'docs',
      'finalize',
      'done',
    ]);
  });

  const investigate = codeWorkflowV2.stages.find((s) => s.id === 'investigate');
  it('the investigate stage is the architect, senior, creates the worktree, syncs main and is skipped per card', () => {
    expect(investigate).toMatchObject({
      claimRole: 'architect',
      seniorOnly: true,
      worktree: 'create',
      syncMainBefore: true,
      maxShiftMinutes: 90,
      when: { field: 'designNeeded', equals: true },
    });
    expect(investigate?.requiredFields).toEqual(['title', 'cardType', 'context', 'requirements', 'repoId']);
    expect(codeWorkflowV2.stages.find((s) => s.id === 'build')).toMatchObject({
      worktree: 'create',
      syncMainBefore: true,
    });
  });

  it('the specify step skips investigate unless the card wants it', () => {
    expect(resolveOutcome(codeWorkflowV2, { designNeeded: false }, 'spec', 'specified').toStage).toBe(
      'build',
    );
    expect(resolveOutcome(codeWorkflowV2, {}, 'spec', 'specified').toStage).toBe('build');
    expect(resolveOutcome(codeWorkflowV2, { designNeeded: true }, 'spec', 'specified').toStage).toBe(
      'investigate',
    );
  });

  it('handoff and report are guarded by investigationOnly; the other one is refused', () => {
    const only = { designNeeded: true, investigationOnly: true };
    const normal = { designNeeded: true, investigationOnly: false };
    expect(allowedOutcomes(codeWorkflowV2, only, 'investigate').map((o) => o.id)).toEqual(['report']);
    expect(allowedOutcomes(codeWorkflowV2, normal, 'investigate').map((o) => o.id)).toEqual(['handoff']);
    expect(resolveOutcome(codeWorkflowV2, normal, 'investigate', 'handoff').toStage).toBe('build');
    expect(resolveOutcome(codeWorkflowV2, only, 'investigate', 'report').toStage).toBe('finalize');
    expect(() => resolveOutcome(codeWorkflowV2, normal, 'investigate', 'report')).toThrow(
      WorkflowResolveError,
    );
    try {
      resolveOutcome(codeWorkflowV2, only, 'investigate', 'handoff');
    } catch (e) {
      expect((e as WorkflowResolveError).code).toBe('outcome_not_allowed');
    }
  });

  it('a build card needs the full field set at specify, an investigation-only card the short one', () => {
    expect(requiredForSpecify(codeWorkflowV2, { designNeeded: false })).toEqual(build);
    expect(
      [...requiredForSpecify(codeWorkflowV2, { designNeeded: true, investigationOnly: false })].sort(),
    ).toEqual([...build].sort());
    expect(requiredForSpecify(codeWorkflowV2, { designNeeded: true, investigationOnly: true })).toEqual([
      'title',
      'cardType',
      'context',
      'requirements',
      'repoId',
    ]);
    expect(
      missingForSpecify(codeWorkflowV2, {
        title: 't',
        cardType: 'feature',
        repoId: 'r',
        designNeeded: true,
        investigationOnly: true,
        fields: { context: 'c', requirements: 'r' },
      }),
    ).toEqual([]);
    // v1 behaves as before
    expect(requiredForSpecify(codeWorkflowV1, {})).toEqual(build);
  });

  it('the outcomes carry investigation data, validated', () => {
    const schema = outcomeDataSchema('investigation');
    expect(schema.safeParse({ reportPath: 'docs/x.md', summary: 's', location: 'repo' }).success).toBe(true);
    expect(schema.safeParse({ reportPath: 'docs/x.md', summary: 's' }).success).toBe(false);
    expect(
      schema.safeParse({ reportPath: 'docs/x.md', summary: 's'.repeat(2001), location: 'repo' }).success,
    ).toBe(false);
  });
});

describe('phases and investigations finalized without a repository step', () => {
  it('a card finalized with action none is finished: it has no branch to wait for', () => {
    expect(memberOutcome({ status: 'done', finalized: true, action: 'none', merged: false })).toBe(
      'finalized',
    );
    expect(memberOutcome({ status: 'done', finalized: true, action: 'push_branch', merged: false })).toBe(
      'waiting_merge',
    );
    expect(
      phaseCompletion([
        {
          status: 'done',
          assignment: 'confirmed',
          finalized: true,
          action: 'none',
          merged: false,
          published: false,
        },
      ]),
    ).toBe('complete');
  });
});

describe('where the report goes', () => {
  const base = { ref: 'TOY-7', title: 'Which queue should we use?' };
  it('card path, then project, then docs/investigations in the repository', () => {
    expect(resolveReportTarget({ ...base })).toEqual({
      location: 'repo',
      reportPath: 'docs/investigations/TOY-7-which-queue-should-we-use.md',
      folder: INVESTIGATION_DEFAULT_PATH,
    });
    expect(resolveReportTarget({ ...base, projectPath: 'design', projectLocation: 'vault' })).toMatchObject({
      location: 'vault',
      reportPath: 'design/TOY-7-which-queue-should-we-use.md',
    });
    expect(
      resolveReportTarget({ ...base, cardReportPath: 'docs/answers/queue.md', projectPath: 'design' }),
    ).toEqual({
      location: 'repo',
      reportPath: 'docs/answers/queue.md',
      folder: 'docs/answers',
    });
    expect(resolveReportTarget({ ...base, cardReportPath: 'vault:research/notes' })).toMatchObject({
      location: 'vault',
      reportPath: 'research/notes/TOY-7-which-queue-should-we-use.md',
    });
  });

  it('ignores a card or project path that is not a safe relative path', () => {
    for (const bad of ['../x.md', '/etc/passwd', 'a/../../b', 'C:\\x.md', 'vault:../x', ''])
      expect(resolveReportTarget({ ...base, cardReportPath: bad, projectPath: bad }).reportPath, bad).toBe(
        'docs/investigations/TOY-7-which-queue-should-we-use.md',
      );
  });
});

describe('secrets in a report', () => {
  it('flags the obvious ones by kind, never echoing the value', () => {
    const hits = scanReportForSecrets(
      [
        `token ghp_${'a'.repeat(36)}`,
        'AKIAABCDEFGHIJKLMNOP',
        '-----BEGIN RSA PRIVATE KEY-----',
        'password: "hunter2hunter2hunter2"',
        `sk-${'x'.repeat(30)}`,
      ].join('\n'),
    );
    expect(hits).toEqual(
      expect.arrayContaining([
        'a GitHub token',
        'an AWS access key id',
        'a private key block',
        'a credential assignment',
        'an API secret key (sk-...)',
      ]),
    );
    expect(hits.join(' ')).not.toContain('hunter2');
  });

  it('lets ordinary prose and code through', () => {
    expect(
      scanReportForSecrets(
        'The password policy requires 12 characters. Set `token` in the config (see docs).',
      ),
    ).toEqual([]);
  });
});

describe('PROJECT.md investigations section', () => {
  it('lists every investigation, oldest first, with links relative to the project folder for the vault', () => {
    const text = renderInvestigationsIndex(
      [
        {
          cardRef: 'TOY-2',
          title: 'Queue [choice]',
          reportPath: 'projects/toy/docs/investigations/TOY-2-queue.md',
          location: 'vault',
          recordedAt: '2026-10-12T10:00:00.000Z',
          decision: true,
          summary: 'Use the outbox.',
        },
        {
          cardRef: 'TOY-1',
          title: 'Auth options',
          reportPath: 'docs/investigations/TOY-1-auth.md',
          location: 'repo',
          recordedAt: '2026-10-10T10:00:00.000Z',
          decision: false,
          summary: 'Use OIDC.',
        },
      ],
      { folder: 'projects/toy' },
    );
    expect(text.indexOf('TOY-1')).toBeLessThan(text.indexOf('TOY-2'));
    expect(text).toContain('[docs/investigations/TOY-2-queue.md](docs/investigations/TOY-2-queue.md)');
    expect(text).toContain('`docs/investigations/TOY-1-auth.md` (in the repository)');
    expect(text).toContain('(decision)');
    expect(text).toContain('Queue choice');
    expect(renderInvestigationsIndex([])).toContain('No investigation was recorded yet');
  });
});

describe('links and prompts', () => {
  it('links a file on the forge for the known hosts, nothing for plain git', () => {
    expect(repoFileUrl('https://github.com/acme/toy.git', 'aom/toy-1-x', 'docs/a b.md')).toBe(
      'https://github.com/acme/toy/blob/aom/toy-1-x/docs/a%20b.md',
    );
    expect(repoFileUrl('git@gitlab.com:acme/sub/toy.git', 'main', 'r.md')).toBe(
      'https://gitlab.com/acme/sub/toy/-/blob/main/r.md',
    );
    expect(repoFileUrl('https://bitbucket.org/acme/toy.git', 'main', 'r.md')).toBe(
      'https://bitbucket.org/acme/toy/src/main/r.md',
    );
    expect(repoFileUrl('https://example.test/some/where.git', 'main', 'r.md')).toBeNull();
  });

  it('shows the architect its commands and the report location; the builder the recorded design', () => {
    expect(
      commandForOutcome({ id: 'handoff', label: 'x', kind: 'success', data: 'investigation' }),
    ).toContain('aom design --report');
    expect(commandForOutcome({ id: 'report', label: 'x', kind: 'success', data: 'investigation' })).toContain(
      'aom investigate --report',
    );
    expect(commandForOutcome({ id: 'handoff', label: 'x', kind: 'success', data: 'diffStats' })).toBe(
      'aom handoff --note "<what you did, what to look at, anything risky>"',
    );
    const brief = (stage: string, investigation: ShiftBrief['investigation']): ShiftBrief =>
      ({
        shift: {
          id: 's',
          kind: 'card',
          stage,
          stageLabel: stage,
          doneCriteria: 'd',
          outcomes: [],
          maxShiftMinutes: 30,
        },
        agent: { id: 'a', name: 'A', seniority: 'senior' },
        card: {
          id: 'c',
          ref: 'TOY-1',
          title: 'T',
          cardType: 'feature',
          fields: {},
          riskTier: null,
          reworkRound: 0,
          completionAction: null,
          docsNeeded: false,
          investigationOnly: false,
          dependencies: [],
        },
        project: {
          id: 'p',
          key: 'TOY',
          name: 'Toy',
          workingBranch: 'main',
          e2eGlobs: [],
          architecturalGlobs: [],
        },
        role: { key: 'x', name: 'X', instructions: '', coreRules: [], skills: [] },
        handoffs: [],
        reviewComments: [],
        thread: [],
        standingOrders: [],
        ledger: [],
        investigation,
      }) as ShiftBrief;
    const arch = renderShiftPrompt(
      brief('investigate', {
        reportPath: 'docs/investigations/TOY-1-t.md',
        location: 'repo',
        investigationOnly: false,
        mergeMainFirst: true,
      }),
    );
    expect(arch).toContain('## Investigation');
    expect(arch).toContain('Write your report to `docs/investigations/TOY-1-t.md`');
    const vault = renderShiftPrompt(
      brief('investigate', {
        reportPath: 'x/TOY-1-t.md',
        location: 'vault',
        investigationOnly: true,
        mergeMainFirst: false,
      }),
    );
    expect(vault).toContain('scratch directory');
    const later = renderShiftPrompt(
      brief('build', {
        reportPath: 'docs/investigations/TOY-1-t.md',
        location: 'repo',
        investigationOnly: false,
        mergeMainFirst: true,
        report: {
          reportPath: 'docs/investigations/TOY-1-t.md',
          location: 'repo',
          summary: 'Use module X.',
          commit: 'abcdef1234567',
        },
      }),
    );
    expect(later).toContain('Recorded report');
    expect(later).toContain('Use module X.');
    expect(later).toContain('Read the report before you start');
    expect(later).not.toContain('Write your report');
  });
});
