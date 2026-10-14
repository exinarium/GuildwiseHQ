import { describe, expect, it } from 'vitest';
import {
  type BrowserToServer,
  BrowserToServerSchema,
  IpcReportRequestSchema,
  IpcReportResponseSchema,
  IpcRpcRequestSchema,
  IpcRpcResponseSchema,
  isAckedFromRunner,
  isAckedFromServer,
  isTerminalReport,
  makeEnvelope,
  outcomeDataSchema,
  RunnerToServerSchema,
  type ServerToBrowser,
  ServerToBrowserSchema,
  ServerToRunnerSchema,
  ShiftReportSchema,
  uuidv7,
} from '../src/index.ts';
import { agentSpec, buildBrief, env, TS, U } from './fixtures.ts';

const roundTrip = (schema: { parse(v: unknown): unknown }, sample: unknown) => {
  const parsed = schema.parse(sample);
  expect(parsed).toEqual(sample);
  // Survives the wire.
  expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(sample);
};

const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
const repos = [{ remoteUrl: 'git@github.com:acme/web.git', localPath: '/src/web', headBranch: 'main' }];
const outcomeReport = { kind: 'outcome' as const, outcomeId: 'handoff', note: 'done', data: {} };

const runnerToServer: Record<string, Record<string, unknown>> = {
  hello: {
    ...env('hello'),
    runnerVersion: '0.1.0',
    protocol: 1,
    platform: 'linux',
    hostname: 'desk',
    runtimes: [{ id: 'claude-code', version: '2.1.0', available: true, capabilities: ['shell', 'edit'] }],
    repos,
    vaults: [{ vaultId: 'v1', localPath: '/vaults/v1', clean: true }],
    activeShifts: [{ shiftId: U.a, cardId: U.c, agentId: U.b, startedAt: TS }],
    outboxPending: 2,
  },
  'outbox.flushed': { ...env('outbox.flushed') },
  heartbeat: { ...env('heartbeat'), activeShifts: [U.a], load: { runningShifts: 1 } },
  'repos.report': { ...env('repos.report'), repos },
  'runner.update': {
    ...env('runner.update'),
    state: 'pending',
    latestVersion: '0.1.1',
    lastCheckedAt: TS,
    detail: '0.1.1 is downloaded and installs as soon as this runner is idle',
  },
  'git.report': {
    ...env('git.report'),
    connections: [
      {
        provider: 'github',
        host: 'github.com',
        state: 'connected',
        account: 'octo',
        method: 'cli',
        checkedAt: '2026-10-10T08:00:00.000Z',
      },
    ],
  },
  'jira.report': {
    ...env('jira.report'),
    status: { state: 'connected', baseUrl: 'https://acme.atlassian.net', account: 'Pieter' },
  },
  'toolchains.report': {
    ...env('toolchains.report'),
    toolchains: [
      {
        name: 'dotnet',
        source: 'detected',
        version: '8.0.425, 10.0.401 (~/.dotnet)',
        binDirs: ['/home/me/.dotnet'],
        readDirs: ['/home/me/.dotnet'],
        envKeys: ['DOTNET_ROOT'],
      },
    ],
  },
  'mcp.servers': {
    ...env('mcp.servers'),
    servers: [
      {
        name: 'plugin_atlassian_atlassian',
        plugin: 'atlassian',
        server: 'atlassian',
        transport: 'http',
        host: 'mcp.atlassian.com',
      },
    ],
  },
  'org.folders': {
    ...env('org.folders'),
    folders: [
      {
        orgId: '0192f3a0-0000-7000-8000-000000000900',
        folder: '/home/me/src/acme',
        valid: true,
        reason: null,
        repoCount: 3,
      },
    ],
    candidates: ['/home/me/src/acme'],
  },
  'runtimes.report': {
    ...env('runtimes.report'),
    runtimes: [
      {
        id: 'claude-code',
        version: '2.1.288',
        available: false,
        capabilities: [],
        sandbox: 'unavailable',
        sandboxReason: 'Native Windows: install the runner in WSL2',
      },
    ],
  },
  'shift.accepted': { ...env('shift.accepted'), shiftId: U.a },
  'shift.rejected': {
    ...env('shift.rejected'),
    shiftId: U.a,
    reason: 'rebase_conflict',
    detail: 'conflict',
    conflictedFiles: ['a.ts'],
  },
  'shift.started': {
    ...env('shift.started'),
    shiftId: U.a,
    runtimeSessionId: 's1',
    worktree: {
      path: '/wt/WEB-12',
      branchName: 'aom/web-12-x',
      baseBranch: 'main',
      created: true,
      headSha: 'abc123',
    },
  },
  'shift.progress': {
    ...env('shift.progress'),
    shiftId: U.a,
    items: [{ at: TS, kind: 'tool', text: 'Edit foo.ts' }],
  },
  'shift.report': {
    ...env('shift.report'),
    shiftId: U.a,
    reportId: U.d,
    report: outcomeReport,
    diffStats: { files: 2, added: 10, removed: 1, architecturalPaths: [] },
    riskTier: 'small',
  },
  'repo.sync_status': {
    ...env('repo.sync_status'),
    status: {
      repoId: U.a,
      workingBranch: 'dev',
      state: 'behind',
      ahead: 0,
      behind: 2,
      dirty: false,
      onBranch: true,
      checkedOutBranch: 'dev',
      checkedAt: '2026-10-14T10:00:00.000Z',
    },
  },
  'shift.ended': {
    ...env('shift.ended'),
    shiftId: U.a,
    outcome: 'reported',
    exitCode: 0,
    durationMs: 1234,
    usage,
    finalText: 'bye',
    guardViolations: [{ rule: 'reviewer_modified_code', detail: 'x' }],
  },
  'worktrees.query': {
    ...env('worktrees.query'),
    queryId: 'q1',
    paths: ['/home/u/.aom-runner/worktrees/TOY-1a2b3c4d/TOY-1'],
  },
  'rpc.request': {
    ...env('rpc.request'),
    rpcId: 'r1',
    shiftId: U.a,
    method: 'ledger.search',
    params: { query: 'cookies' },
  },
  'chat.delta': { ...env('chat.delta'), chatId: 'c1', threadId: U.c, text: 'hi' },
  'chat.done': { ...env('chat.done'), chatId: 'c1', threadId: U.c, messageText: 'hi there', usage },
  'chat.error': { ...env('chat.error'), chatId: 'c1', threadId: U.c, error: 'boom' },
  'command.result': { ...env('command.result'), commandId: 'k1', ok: true, result: { removed: true } },
  'vault.status': { ...env('vault.status'), vaultId: 'v1', lastPullAt: TS, lastPushAt: null, error: 'x' },
  'vault.conflict': { ...env('vault.conflict'), vaultId: 'v1', files: ['standing-orders.md'] },
  'token.rotate': { ...env('token.rotate') },
  ack: { ...env('ack'), ackOf: U.d },
};

const serverToRunner: Record<string, Record<string, unknown>> = {
  welcome: {
    ...env('welcome'),
    workstationId: U.a,
    serverTime: TS,
    heartbeatSec: 15,
    limits: { maxConcurrentShifts: 4 },
  },
  'shift.start': {
    ...env('shift.start'),
    shiftId: U.a,
    claimId: U.d,
    kind: 'card',
    agent: agentSpec,
    brief: buildBrief(),
    worktree: {
      mode: 'create',
      repoId: U.c,
      remoteUrlNormalized: 'github.com/acme/web',
      baseBranch: 'main',
      branchName: 'aom/web-12-add-login-page',
    },
    prepare: { rebase: false },
    maxShiftMinutes: 60,
  },
  'shift.stop': { ...env('shift.stop'), shiftId: U.a, reason: 'timeout' },
  'shift.kill_tools': { ...env('shift.kill_tools'), shiftId: U.a },
  'shift.report.result': { ...env('shift.report.result'), reportId: U.d, accepted: false, error: 'nope' },
  'worktrees.live': {
    ...env('worktrees.live'),
    queryId: 'q1',
    live: ['/home/u/.aom-runner/worktrees/TOY-1a2b3c4d/TOY-1'],
  },
  'rpc.response': { ...env('rpc.response'), rpcId: 'r1', ok: true, result: { hits: [] } },
  'chat.start': {
    ...env('chat.start'),
    chatId: 'c1',
    threadId: U.c,
    agent: agentSpec,
    message: 'hello',
    resumeSessionId: 's1',
    context: { projectId: U.d, cardRef: 'WEB-12' },
  },
  'chat.cancel': { ...env('chat.cancel'), chatId: 'c1' },
  'token.rotated': { ...env('token.rotated'), token: 'aomr_newtoken' },
  command: {
    ...env('command'),
    commandId: 'k1',
    command: 'worktree.remove',
    payload: { path: '/wt/WEB-12', deleteBranch: false },
  },
  ack: { ...env('ack'), ackOf: U.d },
};

const unionTypes = (s: { options: ReadonlyArray<{ shape: { type: { value: string } } }> }) =>
  s.options.map((o) => o.shape.type.value).sort();

describe('runner protocol', () => {
  it('has a round-trip sample for every runner -> server message', () => {
    expect(Object.keys(runnerToServer).sort()).toEqual(unionTypes(RunnerToServerSchema));
  });
  it.each(Object.entries(runnerToServer))('runner -> server %s round-trips', (_t, sample) => {
    roundTrip(RunnerToServerSchema, sample);
  });

  it('has a round-trip sample for every server -> runner message', () => {
    expect(Object.keys(serverToRunner).sort()).toEqual(unionTypes(ServerToRunnerSchema));
  });
  it.each(Object.entries(serverToRunner))('server -> runner %s round-trips', (_t, sample) => {
    roundTrip(ServerToRunnerSchema, sample);
  });

  it('rejects bad envelopes', () => {
    expect(ServerToRunnerSchema.safeParse({ ...serverToRunner.ack, v: 2 }).success).toBe(false);
    expect(ServerToRunnerSchema.safeParse({ ...serverToRunner.ack, type: 'nope' }).success).toBe(false);
    expect(RunnerToServerSchema.safeParse({ ...runnerToServer.heartbeat, ts: 'yesterday' }).success).toBe(
      false,
    );
    expect(
      RunnerToServerSchema.safeParse({ ...runnerToServer['shift.rejected'], reason: 'sulking' }).success,
    ).toBe(false);
  });

  it('makeEnvelope produces valid envelopes', () => {
    const m = makeEnvelope('shift.accepted', { shiftId: U.a });
    expect(RunnerToServerSchema.parse(m)).toEqual(m);
    expect(m.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('knows which messages are acked', () => {
    for (const t of ['shift.accepted', 'shift.report', 'shift.ended', 'command.result', 'chat.done']) {
      expect(isAckedFromRunner(t)).toBe(true);
    }
    for (const t of ['heartbeat', 'shift.progress', 'hello', 'ack']) expect(isAckedFromRunner(t)).toBe(false);
    expect(isAckedFromServer('shift.stop')).toBe(true);
    expect(isAckedFromServer('shift.start')).toBe(false);
  });

  it('uuidv7 ids are version 7', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/);
  });
});

describe('browser protocol', () => {
  const toServer: Record<string, BrowserToServer> = {
    hello: { type: 'hello', lastSeq: 42 },
    'chat.send': { type: 'chat.send', threadId: U.c, body: 'hi', clientMsgId: 'm1' },
    'chat.cancel': { type: 'chat.cancel', threadId: U.c },
    'shift.watch': { type: 'shift.watch', shiftId: U.a },
    'shift.unwatch': { type: 'shift.unwatch', shiftId: U.a },
    ping: { type: 'ping' },
  };
  const toBrowser: Record<string, ServerToBrowser> = {
    ready: { type: 'ready', seq: 10 },
    event: {
      type: 'event',
      event: {
        seq: 11,
        type: 'CardCreated',
        streamId: `card-${U.c}`,
        payload: { cardId: U.c },
        actor: { kind: 'user', id: U.a },
        projectId: U.d,
        createdAt: TS,
      },
    },
    resync: { type: 'resync' },
    'shift.progress': {
      type: 'shift.progress',
      shiftId: U.a,
      cardId: U.c,
      items: [{ at: TS, kind: 'text', text: 'working' }],
    },
    'chat.delta': { type: 'chat.delta', threadId: U.c, text: 'hi' },
    'chat.done': { type: 'chat.done', threadId: U.c, messageId: U.d },
    'chat.error': { type: 'chat.error', threadId: U.c, reason: 'workstation_offline' },
    presence: { type: 'presence', workstationId: U.a, connected: true },
    pong: { type: 'pong' },
  };
  it('has a sample for every message', () => {
    expect(Object.keys(toServer).sort()).toEqual(
      BrowserToServerSchema.options.map((o) => o.shape.type.value).sort(),
    );
    expect(Object.keys(toBrowser).sort()).toEqual(
      ServerToBrowserSchema.options.map((o) => o.shape.type.value).sort(),
    );
  });
  it.each(Object.entries(toServer))('client -> server %s round-trips', (_t, s) =>
    roundTrip(BrowserToServerSchema, s),
  );
  it.each(Object.entries(toBrowser))('server -> client %s round-trips', (_t, s) =>
    roundTrip(ServerToBrowserSchema, s),
  );
});

describe('ipc', () => {
  const reports = {
    outcome: outcomeReport,
    question: {
      kind: 'question',
      text: 'Which db?',
      options: ['pg', 'sqlite'],
      recommend: 0,
      doing: 'picking a db',
      force: false,
      blocking: true,
    },
    comment: { kind: 'comment', note: 'fyi' },
  } as const;
  it.each(Object.entries(reports))('report %s round-trips', (_k, r) => {
    roundTrip(ShiftReportSchema, r);
    roundTrip(IpcReportRequestSchema, { report: r });
  });
  it('applies question defaults', () => {
    expect(ShiftReportSchema.parse({ kind: 'question', text: 'q' })).toEqual({
      force: false,
      kind: 'question',
      text: 'q',
      options: [],
      doing: '',
      blocking: true,
    });
  });
  it('terminal reports', () => {
    expect(isTerminalReport(reports.outcome)).toBe(true);
    expect(isTerminalReport(ShiftReportSchema.parse(reports.question))).toBe(true);
    expect(isTerminalReport(ShiftReportSchema.parse({ ...reports.question, blocking: false }))).toBe(false);
    expect(isTerminalReport(reports.comment)).toBe(false);
  });
  it('responses and rpc round-trip', () => {
    roundTrip(IpcReportResponseSchema, {
      accepted: true,
      message: 'Recorded. Finish now; do not make further changes.',
    });
    roundTrip(IpcReportResponseSchema, {
      accepted: false,
      message: 'rejected',
      error: 'guard',
      guardViolations: [{ rule: 'reviewer_modified_code', detail: 'x' }],
    });
    roundTrip(IpcRpcRequestSchema, { method: 'card.get', params: {} });
    roundTrip(IpcRpcResponseSchema, { ok: true, result: { a: 1 } });
    roundTrip(IpcRpcResponseSchema, { ok: false, error: 'nope' });
  });
  it('validates outcome data by kind', () => {
    expect(outcomeDataSchema('review').safeParse({ score: 4, reasons: ['weak_tests'] }).success).toBe(true);
    expect(outcomeDataSchema('review').safeParse({ score: 9 }).success).toBe(false);
    expect(
      outcomeDataSchema('testEvidence').safeParse({
        commands: ['pnpm test'],
        summary: 'ok',
        outputExcerpt: '',
      }).success,
    ).toBe(true);
    expect(outcomeDataSchema('testEvidence').safeParse({}).success).toBe(false);
    expect(outcomeDataSchema('none').safeParse({}).success).toBe(true);
  });
});
