import { describe, expect, it } from 'vitest';
import {
  CommandPayloadSchemas,
  DEFAULT_DEVOPS_ACCESS,
  DomainEventSchema,
  decisionFilePath,
  devopsBriefOutcomes,
  isSafeVaultPath,
  needsApproval,
  outcomeDataSchema,
  projectVaultFolder,
  RegisterVaultRequestSchema,
  renderDecisionFile,
  renderDevopsInstructions,
  renderDevopsPrompt,
  renderInstructions,
  ServerToRunnerSchema,
} from '../src/index.ts';
import { agentSpec, buildBrief, env, TS, U } from './fixtures.ts';

describe('M3 events', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      'VaultRegistered',
      { vaultId: U.a, orgId: U.b, kind: 'work', name: 'Work', remoteUrl: '/x.git', syncIntervalSec: 300 },
    ],
    [
      'VaultUpdated',
      {
        vaultId: U.a,
        orgId: U.b,
        projectId: U.c,
        kind: 'project',
        name: 'P',
        remoteUrl: '/x',
        syncIntervalSec: 5,
      },
    ],
    ['VaultSyncConflict', { vaultId: U.a, workstationId: U.b, files: ['a.md'], deskItemId: U.c }],
    ['VaultConflictResolved', { vaultId: U.a, workstationId: U.b, resolvedBy: U.c }],
    [
      'DevOpsRequested',
      {
        requestId: U.a,
        workstationId: U.b,
        devopsAgentId: U.c,
        threadId: U.a,
        requestedBy: { kind: 'agent', id: U.d, name: 'Ada' },
        summary: 'start the app',
      },
    ],
    ['DevOpsShiftDispatched', { requestId: U.a, shiftId: U.b, agentId: U.c, workstationId: U.d }],
    [
      'EnvironmentChanged',
      { changeId: U.a, workstationId: U.b, summary: 'installed x', commands: ['apt x'] },
    ],
    ['DevOpsApprovalNeeded', { requestId: U.a, deskItemId: U.b, action: 'install docker', reason: 'r' }],
    ['DevOpsApprovalResolved', { requestId: U.a, deskItemId: U.b, resolution: 'approved', resolvedBy: U.c }],
    ['DevOpsRequestRequeued', { requestId: U.a, reason: 'runner rejected' }],
    ['DevOpsRequestCompleted', { requestId: U.a, status: 'done', summary: 'ok' }],
    ['DevOpsAccessChanged', { workstationId: U.a, access: { allowInstall: true }, changedBy: U.b }],
    ['ProjectShared', { projectId: U.a, userId: U.b, invitedBy: U.c }],
    ['ProjectShareAccepted', { projectId: U.a, userId: U.b }],
    ['ProjectShareDeclined', { projectId: U.a, userId: U.b }],
    [
      'ProjectMemberRemoved',
      { projectId: U.a, userId: U.b, removedBy: U.c, inheritedAgentIds: [U.d], transferredCardIds: [] },
    ],
    ['CardRehomed', { cardId: U.a, by: U.b }],
  ];
  it.each(cases)('parses %s', (type, payload) => {
    const r = DomainEventSchema.safeParse({ type, payload });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('fills DevOps access defaults', () => {
    const r = DomainEventSchema.parse({
      type: 'DevOpsAccessChanged',
      payload: { workstationId: U.a, access: {}, changedBy: U.b },
    });
    expect(r.type === 'DevOpsAccessChanged' && r.payload.access).toEqual(DEFAULT_DEVOPS_ACCESS);
  });
  it('rejects a vault with a zero interval and a bad kind', () => {
    const bad = (over: Record<string, unknown>) =>
      DomainEventSchema.safeParse({
        type: 'VaultRegistered',
        payload: {
          vaultId: U.a,
          orgId: U.b,
          kind: 'work',
          name: 'W',
          remoteUrl: '/x',
          syncIntervalSec: 5,
          ...over,
        },
      }).success;
    expect(bad({})).toBe(true);
    expect(bad({ syncIntervalSec: 0 })).toBe(false);
    expect(bad({ kind: 'team' })).toBe(false);
  });
});

describe('M3 protocol', () => {
  it('shift.start carries the devops request and the card vault', () => {
    const brief = buildBrief();
    const msg = {
      ...env('shift.start'),
      shiftId: U.a,
      claimId: U.b,
      kind: 'devops',
      agent: agentSpec,
      brief,
      worktree: null,
      prepare: { rebase: false },
      maxShiftMinutes: 30,
      devops: {
        requestId: U.c,
        threadId: U.c,
        summary: 'start the app',
        requestedBy: { kind: 'user', id: U.d },
        workstationName: 'Desk',
        access: DEFAULT_DEVOPS_ACCESS,
      },
      vault: { vaultId: U.d, kind: 'work', folder: 'projects/web' },
    };
    const parsed = ServerToRunnerSchema.parse(msg);
    expect(parsed.type === 'shift.start' && parsed.devops?.history).toEqual([]);
    expect(parsed.type === 'shift.start' && parsed.vault?.folder).toBe('projects/web');
  });
  it('vault commands have typed payloads', () => {
    const cfg = CommandPayloadSchemas['vault.configure'].parse({
      vaults: [{ vaultId: 'v1', kind: 'work', name: 'Work', remoteUrl: '/x.git', syncIntervalSec: 60 }],
      identity: { name: 'Atlas (aom)', email: 'a@agents.aom.invalid' },
    });
    expect(cfg.resume).toEqual([]);
    const w = CommandPayloadSchemas['vault.write'].parse({
      vaultId: 'v1',
      path: 'projects/web/decisions/x.md',
      mode: 'create',
      content: 'hi',
      commitMessage: 'm',
    });
    expect(w.push).toBe(true);
  });
  it('devops outcome data is validated', () => {
    expect(outcomeDataSchema('devopsDone').safeParse({ summary: 's' }).success).toBe(true);
    expect(outcomeDataSchema('devopsDone').safeParse({}).success).toBe(false);
    expect(outcomeDataSchema('devopsApproval').safeParse({ action: 'a', reason: 'r' }).success).toBe(true);
    expect(devopsBriefOutcomes().map((o) => o.id)).toEqual(['devops_done', 'devops_approval']);
  });
});

describe('vault helpers', () => {
  it('rejects unsafe vault paths', () => {
    for (const p of ['../x', '/etc/passwd', 'a/../b', 'a//b', '.git/config', 'a/.git/x', 'C:\\x', 'a\\b', ''])
      expect(isSafeVaultPath(p), p).toBe(false);
    expect(isSafeVaultPath('projects/web/decisions/2026-10-03-x.md')).toBe(true);
  });
  it('derives the project folder', () => {
    expect(projectVaultFolder({ key: 'WEB' })).toBe('projects/web');
    expect(projectVaultFolder({ key: 'WEB', vaultFolder: 'projects/storefront' })).toBe(
      'projects/storefront',
    );
    expect(projectVaultFolder({ key: 'WEB', vaultFolder: 'storefront/' })).toBe('projects/storefront');
  });
  it('renders an ADR-style decision file', () => {
    const d = {
      deskItemId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      question: 'Which database should we use?',
      answer: 'Postgres, because the event store already needs it.',
      askedBy: 'Ada (builder)',
      cardRef: 'WEB-3',
      ledgerEntryId: U.b,
      answeredAt: new Date('2026-10-03T12:00:00Z'),
    };
    expect(decisionFilePath('projects/web', d)).toBe(
      'projects/web/decisions/2026-10-03-which-database-should-we-use-019e3f.md',
    );
    const md = renderDecisionFile(d);
    expect(md).toContain('# Which database should we use?');
    expect(md).toContain('Status: accepted');
    expect(md).toContain('Asked by Ada (builder) on card WEB-3.');
    expect(md).toContain('Postgres, because');
    expect(md).toContain(`Ledger entry: ${U.b}`);
  });
  it('project vaults need a project id, work and personal must not have one', () => {
    const p = (v: Record<string, unknown>) =>
      RegisterVaultRequestSchema.safeParse({ remoteUrl: '/x.git', ...v }).success;
    expect(p({ kind: 'work' })).toBe(true);
    expect(p({ kind: 'work', projectId: U.a })).toBe(false);
    expect(p({ kind: 'project' })).toBe(false);
    expect(p({ kind: 'project', projectId: U.a })).toBe(true);
  });
});

describe('DevOps prompts and instructions', () => {
  const devops = {
    requestId: U.c,
    threadId: U.c,
    summary: 'start the app',
    requestedBy: { kind: 'agent' as const, id: U.d, name: 'Ada' },
    card: { ref: 'WEB-12', title: 'Add login page' },
    workstationName: 'Desk',
    access: { allowInstall: true, allowDocker: false, allowedPaths: ['/srv/apps'], sudo: false },
    history: [],
  };
  const brief = {
    ...buildBrief(),
    agent: { id: U.b, name: 'Atlas', seniority: 'senior' as const },
    shift: { ...buildBrief().shift, kind: 'devops' as const, outcomes: devopsBriefOutcomes() },
  };
  it('instructions state the granted access and the report commands', () => {
    const md = renderDevopsInstructions(brief, devops);
    expect(md).toContain('You are Atlas, the DevOps engineer for the workstation "Desk"');
    expect(md).toContain('Install packages and tools: allowed');
    expect(md).toContain('Docker (install, run, manage containers): NOT allowed');
    expect(md).toContain('/srv/apps');
    expect(md).toContain('aom devops-done --summary');
    expect(md).toContain('aom devops-approval --action');
  });
  it('the prompt carries an approval that was granted', () => {
    const md = renderDevopsPrompt({
      ...devops,
      approval: { action: 'install docker', reason: 'tester needs it', commands: ['apt install docker'] },
    });
    expect(md).toContain('start the app');
    expect(md).toContain('Approved by the manager');
    expect(md).toContain('install docker');
    expect(renderDevopsPrompt(devops)).not.toContain('Approved by the manager');
  });
  it('card instructions render PROJECT.md only when present', () => {
    const b = buildBrief();
    expect(renderInstructions(b)).not.toContain('PROJECT.md');
    const md = renderInstructions({
      ...b,
      project: { ...b.project, projectDoc: 'Use pnpm. Never force push.' },
    });
    expect(md).toContain('## PROJECT.md (from the knowledge vault)');
    expect(md).toContain('Use pnpm. Never force push.');
  });
  it('mock approval rule', () => {
    const none = DEFAULT_DEVOPS_ACCESS;
    expect(needsApproval(none, 'start the app')).toBe(false);
    expect(needsApproval(none, 'install docker')).toBe(true);
    expect(needsApproval({ ...none, allowInstall: true, allowDocker: true }, 'install docker')).toBe(false);
    expect(needsApproval({ ...none, allowInstall: true }, 'install jq')).toBe(false);
    expect(needsApproval(none, 'delete the old build output')).toBe(true);
    expect(needsApproval({ ...none, sudo: true }, 'sudo restart nginx')).toBe(false);
  });
  it('timestamp fixture stays valid', () => {
    expect(TS).toMatch(/^2026/);
  });
});
