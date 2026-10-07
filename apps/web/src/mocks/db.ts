import {
  type AgentDto,
  type BoardResponse,
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  boardColumns,
  type CardDetailResponse,
  type CardDto,
  codeWorkflowV1,
  columnFor,
  getStage,
  type InvitationDto,
  type ProjectDto,
  type ProjectRepoDto,
  type UserDto,
  type WorkstationDto,
} from '@aom/shared';
import type { LiveSocket } from '../ws/socket.ts';

/** In-memory fake server state for MSW dev mode. Not shipped in production builds (dynamic import behind VITE_MSW). */

const iso = (minAgo = 0) => new Date(Date.now() - minAgo * 60_000).toISOString();
const uuid = () => crypto.randomUUID();

export const PASSWORD = 'password123456';
export const ORG_ID = uuid();
export const ME: UserDto = {
  id: uuid(),
  email: 'admin@example.com',
  displayName: 'Ada Admin',
  kind: 'user',
  twoFactorEnabled: false,
  status: 'active',
  createdAt: iso(10_000),
  lastLoginAt: iso(5),
  timezone: 'UTC',
};

export const db = {
  socket: null as LiveSocket | null,
  seq: 100,
  signedIn: false,
  users: [
    ME,
    {
      id: uuid(),
      email: 'sam@example.com',
      displayName: 'Sam Member',
      kind: 'user',
      twoFactorEnabled: false,
      status: 'active',
      createdAt: iso(5000),
      lastLoginAt: null,
    } as UserDto,
  ],
  invitations: [] as InvitationDto[],
  projects: [] as ProjectDto[],
  repos: [] as ProjectRepoDto[],
  workstations: [] as WorkstationDto[],
  agents: [] as AgentDto[],
  cards: [] as CardDto[],
  handoffs: new Map<string, CardDetailResponse['handoffs']>(),
  thread: new Map<string, CardDetailResponse['thread']>(),
  transitions: new Map<string, CardDetailResponse['transitions']>(),
  shifts: new Map<string, NonNullable<CardDetailResponse['currentShift']>>(),
  nextNumber: 1,
  nameSeed: 0,
};

export const roles = BUILTIN_ROLES;
export const workflows = BUILTIN_WORKFLOWS;

export function emit(type: string, streamId: string, projectId: string | null) {
  db.socket?.handle({
    type: 'event',
    event: {
      seq: ++db.seq,
      type,
      streamId,
      payload: {},
      actor: { kind: 'user', id: ME.id },
      projectId,
      createdAt: iso(),
    },
  });
}

export function mkCard(p: Partial<CardDto> & Pick<CardDto, 'projectId' | 'title'>): CardDto {
  const project = db.projects.find((x) => x.id === p.projectId);
  const number = db.nextNumber++;
  const id = uuid();
  const card: CardDto = {
    id,
    number,
    ref: `${project?.key ?? 'X'}-${number}`,
    cardType: 'feature',
    workflowKey: 'code',
    workflowVersion: 1,
    stage: 'build',
    status: 'queued',
    column: 'To do',
    fields: {},
    ownerUserId: ME.id,
    decisionPolicy: 'owner_only',
    riskTier: null,
    riskTierOverridden: false,
    docsNeeded: false,
    completionAction: null,
    repoId: null,
    baseBranch: null,
    branchName: null,
    homeWorkstationId: null,
    parentCardId: null,
    origin: 'manual',
    scheduled: false,
    priority: 5,
    reworkRound: 0,
    claimedByAgentId: null,
    claimedByAgentName: null,
    claimedAt: null,
    queuedAt: iso(),
    blockedSince: null,
    dependencies: [],
    createdAt: iso(),
    updatedAt: iso(),
    finalizedAt: null,
    ...p,
  };
  card.column = columnOf(card);
  db.cards.push(card);
  db.transitions.set(id, [
    {
      id: 1,
      fromStage: null,
      toStage: card.stage,
      fromStatus: null,
      toStatus: card.status,
      agentId: null,
      userId: ME.id,
      reason: 'created',
      at: card.createdAt,
    },
  ]);
  return card;
}

export function columnOf(card: CardDto): string {
  const stage = getStage(codeWorkflowV1, card.stage) ?? codeWorkflowV1.stages[0]!;
  return columnFor(card, stage);
}

export function transition(
  card: CardDto,
  toStage: string,
  toStatus: CardDto['status'],
  reason: string,
  agentId: string | null = null,
) {
  const list = db.transitions.get(card.id) ?? [];
  list.push({
    id: list.length + 1,
    fromStage: card.stage,
    toStage,
    fromStatus: card.status,
    toStatus,
    agentId,
    userId: agentId ? null : ME.id,
    reason,
    at: iso(),
  });
  db.transitions.set(card.id, list);
  card.stage = toStage;
  card.status = toStatus;
  card.updatedAt = iso();
  card.column = columnOf(card);
  if (toStatus !== 'claimed') {
    card.claimedByAgentId = null;
    card.claimedByAgentName = null;
    card.claimedAt = null;
  }
  emit('CardMovedByManager', `card-${card.id}`, card.projectId);
}

export function buildBoard(projectId: string): BoardResponse {
  const names = boardColumns(codeWorkflowV1);
  const columns = names.map((name) => ({ name, cards: [] as BoardResponse['columns'][number]['cards'] }));
  for (const c of db.cards.filter((x) => x.projectId === projectId && x.status !== 'cancelled')) {
    const col = columns.find((x) => x.name === c.column);
    col?.cards.push({
      id: c.id,
      ref: c.ref,
      title: c.title,
      cardType: c.cardType,
      stage: c.stage,
      status: c.status,
      assignee:
        c.claimedByAgentId && c.claimedByAgentName
          ? { agentId: c.claimedByAgentId, name: c.claimedByAgentName }
          : null,
      updatedAt: c.updatedAt,
      queuedAt: c.queuedAt,
      riskTier: c.riskTier,
      blocked: c.status === 'blocked',
      reworkRound: c.reworkRound,
      priority: c.priority,
    });
  }
  return { projectId, workflowKey: 'code', columns };
}

export function agentView(a: AgentDto): AgentDto {
  const active = db.cards
    .filter((c) => c.claimedByAgentId === a.id)
    .map((c) => ({ cardId: c.id, ref: c.ref, title: c.title }));
  return { ...a, activeCards: active };
}

export function detail(card: CardDto): CardDetailResponse {
  const shift = db.shifts.get(card.id) ?? null;
  return {
    card,
    handoffs: db.handoffs.get(card.id) ?? [],
    transitions: db.transitions.get(card.id) ?? [],
    activity: [],
    threadId: card.id,
    thread: db.thread.get(card.id) ?? [],
    currentShift: shift && card.status === 'claimed' ? shift : null,
    permissions: {
      canEdit: card.status === 'draft' || card.status === 'queued',
      canSetPhase: false,
      canSetRisk: card.status !== 'cancelled' && card.status !== 'done',
      canSpecify: card.status === 'draft',
      canMove: card.status !== 'cancelled' && card.status !== 'done',
      canRelease: card.status === 'claimed',
      canReleaseBackoff: !!card.backoff,
      canCancel: card.status !== 'cancelled' && card.status !== 'done',
      canComment: true,
    },
    diffStats: null,
    blockers: [],
  };
}

/** Simulated builder: claims a queued build card, streams progress, hands off to review. */
export function simulateBuilder(card: CardDto) {
  setTimeout(() => {
    const builder = db.agents.find(
      (a) =>
        a.roleKey === 'builder' &&
        a.status === 'active' &&
        !db.cards.some((c) => c.claimedByAgentId === a.id),
    );
    if (!builder || card.status !== 'queued' || card.stage !== 'build') return;
    card.status = 'claimed';
    card.claimedByAgentId = builder.id;
    card.claimedByAgentName = builder.name;
    card.claimedAt = iso();
    card.column = columnOf(card);
    const shiftId = uuid();
    db.shifts.set(card.id, {
      id: shiftId,
      agentId: builder.id,
      agentName: builder.name,
      workstationId: builder.workstationId ?? uuid(),
      cardId: card.id,
      cardRef: card.ref,
      kind: 'card',
      stage: 'build',
      status: 'running',
      outcome: null,
      reportOutcome: null,
      runtime: builder.runtime,
      model: builder.model,
      overflow: false,
      startedAt: iso(),
      endedAt: null,
      durationMs: null,
      tokensInput: null,
      tokensOutput: null,
      tokensCacheRead: null,
      tokensCacheWrite: null,
      progressTail: [{ at: iso(), kind: 'status', text: 'Shift started' }],
    });
    emit('CardClaimed', `card-${card.id}`, card.projectId);
    const lines = [
      'Reading the card',
      'tool: Read src/index.ts',
      'Writing unit tests',
      'tool: Bash pnpm test',
      'Committing work',
    ];
    for (const [i, text] of lines.entries()) {
      setTimeout(
        () => {
          db.socket?.handle({
            type: 'shift.progress',
            shiftId,
            cardId: card.id,
            items: [{ at: iso(), kind: text.startsWith('tool:') ? 'tool' : 'text', text }],
          });
        },
        1000 * (i + 1),
      );
    }
    setTimeout(() => {
      if (card.claimedByAgentId !== builder.id) return;
      const list = db.handoffs.get(card.id) ?? [];
      list.push({
        id: uuid(),
        cardId: card.id,
        shiftId,
        agentId: builder.id,
        agentName: builder.name,
        stage: 'build',
        outcome: 'handoff',
        note: 'Implemented with unit tests.',
        data: {},
        createdAt: iso(),
      });
      db.handoffs.set(card.id, list);
      transition(card, 'review', 'queued', 'handoff', builder.id);
    }, 7000);
  }, 1500);
}

export function seed() {
  const projectId = uuid();
  db.projects.push({
    id: projectId,
    orgId: ORG_ID,
    key: 'TOY',
    name: 'Toy project',
    workflowKey: 'code',
    rank: 1,
    branchPrefix: 'aom/',
    workingBranch: 'main',
    subCategories: [],
    vaultFolder: null,
    architecturalGlobs: [],
    e2eGlobs: [],
    status: 'active',
    createdAt: iso(2000),
    myRole: 'owner',
  });
  const repoId = uuid();
  db.repos.push({
    id: repoId,
    projectId,
    name: 'toy',
    remoteUrl: 'git@example.com:acme/toy.git',
    remoteUrlNormalized: 'example.com/acme/toy',
    workingBranch: 'main',
    removedAt: null,
  });
  const wsId = uuid();
  db.workstations.push({
    id: wsId,
    userId: ME.id,
    name: 'Desktop',
    platform: 'linux',
    hostname: 'desk',
    runnerVersion: '0.1.0',
    status: 'active',
    connected: true,
    lastSeenAt: iso(1),
    runtimes: [
      { id: 'mock', version: '1', available: true, capabilities: [] },
      { id: 'claude-code', version: '2.1.0', available: true, capabilities: ['shell'] },
    ],
    repos: [{ projectRepoId: repoId, localPath: '/home/ada/src/toy', reportedAt: iso(3) }],
    pairedAt: iso(1000),
  });
  const mkAgent = (name: string, roleKey: string, seniority: 'junior' | 'senior'): AgentDto => ({
    id: uuid(),
    orgId: ORG_ID,
    hiredForProjectId: projectId,
    allowedProjectIds: [projectId],
    focusProjectIds: [],
    hiredByUserId: ME.id,
    managerUserId: ME.id,
    workstationId: wsId,
    name,
    roleKey,
    roleVersion: 1,
    seniority,
    runtime: 'mock',
    model: 'mock',
    effort: null,
    skills: [],
    permissions: roles.find((r) => r.key === roleKey)!.permissions,
    capacity: 1,
    isDevops: false,
    status: 'active',
    hiredAt: iso(900),
    retiredAt: null,
    lastShiftEndedAt: null,
    activeCards: [],
  });
  const ada = mkAgent('Marlowe', 'builder', 'junior');
  const rev = mkAgent('Quinn', 'reviewer', 'senior');
  db.agents.push(ada, rev);
  const base = { projectId };
  mkCard({ ...base, title: 'Draft: onboarding copy', status: 'draft', stage: 'spec', cardType: 'docs' });
  mkCard({ ...base, title: 'Add rate limiting to login', riskTier: 'large', priority: 3 });
  const rework = mkCard({
    ...base,
    title: 'Fix date parsing in importer',
    cardType: 'bug',
    reworkRound: 1,
    riskTier: 'small',
  });
  const inProg = mkCard({
    ...base,
    title: 'Search box debounce',
    status: 'claimed',
    claimedByAgentId: ada.id,
    claimedByAgentName: ada.name,
    claimedAt: iso(4),
    riskTier: 'small',
  });
  mkCard({
    ...base,
    title: 'Await product answer on export format',
    status: 'blocked',
    blockedSince: iso(60),
    riskTier: 'small',
  });
  mkCard({ ...base, title: 'Refactor settings store', stage: 'review', riskTier: 'large' });
  mkCard({ ...base, title: 'Upgrade dependencies', stage: 'test', status: 'queued' });
  mkCard({ ...base, title: 'Landing page refresh', stage: 'done', status: 'done' });
  db.handoffs.set(rework.id, [
    {
      id: uuid(),
      cardId: rework.id,
      shiftId: null,
      agentId: ada.id,
      agentName: ada.name,
      stage: 'build',
      outcome: 'handoff',
      note: 'First pass done.',
      data: {},
      createdAt: iso(120),
    },
    {
      id: uuid(),
      cardId: rework.id,
      shiftId: null,
      agentId: rev.id,
      agentName: rev.name,
      stage: 'review',
      outcome: 'changes',
      note: 'Time zones are ignored.',
      data: {
        score: 2,
        reasons: ['missed_requirement', 'weak_tests'],
        criteriaMissed: ['Handles UTC offsets'],
      },
      createdAt: iso(90),
    },
  ]);
  db.thread.set(rework.id, [
    {
      id: uuid(),
      threadId: rework.id,
      authorKind: 'user',
      authorUserId: ME.id,
      authorAgentId: null,
      authorName: ME.displayName,
      kind: 'comment',
      body: 'Please also cover DST edges.',
      data: {},
      createdAt: iso(80),
    },
  ]);
  inProg.fields = {
    context: 'The search box fires a request per keystroke.',
    acceptanceCriteria: ['Requests are debounced by 250 ms', 'Enter submits immediately'],
  };
  db.shifts.set(inProg.id, {
    id: uuid(),
    agentId: ada.id,
    agentName: ada.name,
    workstationId: wsId,
    cardId: inProg.id,
    cardRef: inProg.ref,
    kind: 'card',
    stage: 'build',
    status: 'running',
    outcome: null,
    reportOutcome: null,
    runtime: 'mock',
    model: 'mock',
    overflow: false,
    startedAt: iso(4),
    endedAt: null,
    durationMs: null,
    tokensInput: null,
    tokensOutput: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    progressTail: [
      { at: iso(3), kind: 'status', text: 'Shift started' },
      { at: iso(2), kind: 'text', text: 'Reading the card' },
      { at: iso(1), kind: 'tool', text: 'Edit src/search.ts' },
    ],
  });
  db.invitations.push({
    id: uuid(),
    email: 'new@example.com',
    role: 'member',
    status: 'pending',
    invitedBy: ME.id,
    expiresAt: iso(-60 * 24 * 7),
    createdAt: iso(10),
    acceptedAt: null,
  });
}
seed();
