import {
  AcceptInvitationRequestSchema,
  AddRepoRequestSchema,
  type AgentDto,
  CreateCardRequestSchema,
  CreateInvitationRequestSchema,
  CreateProjectRequestSchema,
  codeWorkflowV1,
  getStage,
  HireAgentRequestSchema,
  LoginRequestSchema,
  MoveCardRequestSchema,
  PatchProjectRequestSchema,
  requiredMissing,
} from '@aom/shared';
import { HttpResponse, http } from 'msw';
import {
  agentView,
  buildBoard,
  db,
  detail,
  emit,
  ME,
  mkCard,
  ORG_ID,
  PASSWORD,
  roles,
  simulateBuilder,
  transition,
  workflows,
} from './db.ts';
import { extraHandlers } from './handlers-extra.ts';

const err = (status: number, code: string, message: string, details?: unknown) =>
  HttpResponse.json({ error: { code, message, ...(details ? { details } : {}) } }, { status });
const uuid = () => crypto.randomUUID();
const iso = () => new Date().toISOString();
const NAMES = [
  'Marlowe',
  'Quinn',
  'Ripley',
  'Sable',
  'Tamsin',
  'Ulysses',
  'Vesper',
  'Wren',
  'Yara',
  'Zephyr',
  'Ines',
  'Orson',
];

const authed = () => db.signedIn;
const meBody = () => ({
  user: ME,
  account: { kind: 'user' as const },
  isAdmin: true,
  orgs: [],
  activeOrg: null,
  guestIn: [],
  guestProjectIds: [],
  pendingInvitations: 0,
  twoFactor: { enabled: false, required: false, setupRequired: false },
  visibleProjectIds: db.projects.map((p) => p.id),
  features: { mockUi: true },
});

const A = '/api';
const findCard = (key: string) => db.cards.find((c) => c.id === key || c.ref === key);

async function body<T>(
  req: Request,
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } },
) {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  return parsed.success ? (parsed.data as T) : null;
}

export const handlers = [
  http.get(`${A}/health`, () => HttpResponse.json({ ok: true, db: true })),
  http.post(`${A}/auth/login`, async ({ request }) => {
    const b = await body(request, LoginRequestSchema);
    if (!b) return err(400, 'validation', 'Invalid request');
    if (b.email.toLowerCase() !== ME.email || b.password !== PASSWORD)
      return err(401, 'invalid_credentials', 'Invalid credentials');
    db.signedIn = true;
    sessionStorage.setItem('aom:mock-session', '1');
    return HttpResponse.json(meBody());
  }),
  http.post(`${A}/auth/logout`, () => {
    db.signedIn = false;
    sessionStorage.removeItem('aom:mock-session');
    return HttpResponse.json({ ok: true });
  }),
  http.get(`${A}/auth/me`, () => {
    if (!db.signedIn && sessionStorage.getItem('aom:mock-session')) db.signedIn = true;
    return authed() ? HttpResponse.json(meBody()) : err(401, 'unauthenticated', 'Not signed in');
  }),
  http.get(`${A}/invitations/:token`, ({ params }) =>
    String(params.token).startsWith('bad')
      ? err(404, 'not_found', 'Invitation not found')
      : HttpResponse.json({
          email: 'new@example.com',
          role: 'member',
          expiresAt: new Date(Date.now() + 6e8).toISOString(),
        }),
  ),
  http.post(`${A}/invitations/:token/accept`, async ({ request }) => {
    const b = await body(request, AcceptInvitationRequestSchema);
    if (!b) return err(400, 'validation', 'Invalid request');
    db.signedIn = true;
    return HttpResponse.json(meBody());
  }),

  // workstations
  http.get(`${A}/workstations`, () => HttpResponse.json({ workstations: db.workstations })),
  http.post(`${A}/workstations/pairing-codes`, () =>
    HttpResponse.json(
      { code: 'K7QD-4M2X', expiresAt: new Date(Date.now() + 600_000).toISOString() },
      { status: 201 },
    ),
  ),
  http.patch(`${A}/workstations/:id`, async ({ params, request }) => {
    const w = db.workstations.find((x) => x.id === params.id);
    if (w) Object.assign(w, await request.json());
    return HttpResponse.json({ workstation: w });
  }),
  http.post(`${A}/workstations/:id/unlink`, ({ params }) => unlink(String(params.id))),

  // projects
  http.get(`${A}/projects`, ({ request }) => {
    const status = new URL(request.url).searchParams.get('status') ?? 'active';
    return HttpResponse.json({
      projects: db.projects.filter((p) => status === 'all' || p.status === status),
    });
  }),
  http.get(`${A}/projects/:id/impact`, ({ params }) => {
    const id = String(params.id);
    if (!db.projects.some((p) => p.id === id)) return err(404, 'not_found', 'Project not found');
    const cards = db.cards.filter((c) => c.projectId === id && !['done', 'cancelled'].includes(c.status));
    return HttpResponse.json({ activeShifts: 0, openCards: cards.length, schedules: 0, openDeskItems: 0 });
  }),
  http.post(`${A}/projects/:id/archive`, ({ params }) => {
    const project = db.projects.find((p) => p.id === params.id);
    if (!project) return err(404, 'not_found', 'Project not found');
    project.status = 'archived';
    emit('ProjectArchived', `project-${project.id}`, project.id);
    return HttpResponse.json({ project, repos: [], members: [], mergePolicyHistory: [] });
  }),
  http.post(`${A}/projects/:id/restore`, ({ params }) => {
    const project = db.projects.find((p) => p.id === params.id);
    if (!project) return err(404, 'not_found', 'Project not found');
    project.status = 'active';
    emit('ProjectRestored', `project-${project.id}`, project.id);
    return HttpResponse.json({ project, repos: [], members: [], mergePolicyHistory: [] });
  }),
  http.post(`${A}/projects/:id/delete`, async ({ params, request }) => {
    const project = db.projects.find((p) => p.id === params.id);
    const b = (await request.json()) as { confirmKey?: string };
    if (!project) return err(404, 'not_found', 'Project not found');
    if (project.status !== 'archived') return err(409, 'not_archived', 'Archive the project first');
    if (b.confirmKey !== project.key) return err(400, 'key_mismatch', 'Type the project key to confirm');
    db.projects.splice(db.projects.indexOf(project), 1);
    emit('ProjectDeleted', `project-${project.id}`, project.id);
    return HttpResponse.json({ ok: true });
  }),
  http.post(`${A}/projects`, async ({ request }) => {
    const b = await body(request, CreateProjectRequestSchema);
    if (!b) return err(400, 'validation', 'Invalid request');
    if (db.projects.some((p) => p.key === b.key))
      return err(409, 'conflict', `Project key ${b.key} already exists`);
    const project = {
      ...b,
      id: uuid(),
      orgId: ORG_ID,
      architecturalGlobs: [],
      e2eGlobs: [],
      status: 'active' as const,
      createdAt: iso(),
      myRole: 'owner' as const,
    };
    db.projects.push(project);
    emit('ProjectCreated', `project-${project.id}`, project.id);
    return HttpResponse.json({ project }, { status: 201 });
  }),
  http.get(`${A}/projects/:id`, ({ params }) => {
    const project = db.projects.find((p) => p.id === params.id);
    if (!project) return err(404, 'not_found', 'Project not found');
    return HttpResponse.json({
      project,
      repos: db.repos.filter((r) => r.projectId === project.id),
      members: [
        { userId: ME.id, displayName: ME.displayName, email: ME.email, role: 'owner', status: 'active' },
      ],
    });
  }),
  http.patch(`${A}/projects/:id`, async ({ params, request }) => {
    const project = db.projects.find((p) => p.id === params.id);
    const b = await body(request, PatchProjectRequestSchema);
    if (!project || !b) return err(404, 'not_found', 'Project not found');
    Object.assign(project, b);
    emit('ProjectUpdated', `project-${project.id}`, project.id);
    return HttpResponse.json({ project });
  }),
  http.post(`${A}/projects/:id/repos`, async ({ params, request }) => {
    const b = await body(request, AddRepoRequestSchema);
    if (!b) return err(400, 'validation', 'Invalid request');
    const repo = {
      id: uuid(),
      projectId: String(params.id),
      name: b.name,
      remoteUrl: b.remoteUrl,
      remoteUrlNormalized: b.remoteUrl,
      workingBranch: b.workingBranch ?? null,
      removedAt: null,
    };
    db.repos.push(repo);
    emit('ProjectRepoAdded', `project-${params.id}`, String(params.id));
    return HttpResponse.json({ repo }, { status: 201 });
  }),
  http.delete(`${A}/projects/:id/repos/:repoId`, ({ params }) => {
    const r = db.repos.find((x) => x.id === params.repoId);
    if (r) r.removedAt = iso();
    emit('ProjectRepoRemoved', `project-${params.id}`, String(params.id));
    return HttpResponse.json({ ok: true });
  }),

  // board + cards
  http.get(`${A}/board`, ({ request }) => {
    const id = new URL(request.url).searchParams.get('projectId') ?? '';
    return db.projects.some((p) => p.id === id)
      ? HttpResponse.json(buildBoard(id))
      : err(404, 'not_found', 'Project not found');
  }),
  http.post(`${A}/cards`, async ({ request }) => {
    const b = await body(request, CreateCardRequestSchema);
    if (!b) return err(400, 'validation', 'Invalid request');
    const build = getStage(codeWorkflowV1, 'build')!;
    const candidate = {
      title: b.title,
      cardType: b.cardType,
      repoId: b.repoId ?? null,
      completionAction: b.completionAction ?? null,
      docsNeeded: b.docsNeeded ?? false,
      fields: b.fields,
    };
    const missing = b.specify ? requiredMissing(candidate, build) : [];
    const specified = !!b.specify && missing.length === 0;
    const card = mkCard({
      projectId: b.projectId,
      title: b.title,
      cardType: b.cardType,
      fields: b.fields,
      repoId: b.repoId ?? null,
      completionAction: b.completionAction ?? null,
      docsNeeded: b.docsNeeded ?? false,
      priority: b.priority ?? 5,
      stage: specified ? 'build' : 'spec',
      status: specified ? 'queued' : 'draft',
    });
    emit('CardCreated', `card-${card.id}`, card.projectId);
    if (specified) simulateBuilder(card);
    return HttpResponse.json({ card, ...(b.specify && missing.length ? { missing } : {}) }, { status: 201 });
  }),
  http.get(`${A}/cards/:key`, ({ params }) => {
    const c = findCard(String(params.key));
    return c ? HttpResponse.json(detail(c)) : err(404, 'not_found', 'Card not found');
  }),
  http.patch(`${A}/cards/:key`, async ({ params, request }) => {
    const c = findCard(String(params.key));
    if (!c) return err(404, 'not_found', 'Card not found');
    Object.assign(c, await request.json());
    return HttpResponse.json(detail(c));
  }),
  http.post(`${A}/cards/:key/specify`, ({ params }) => {
    const c = findCard(String(params.key));
    if (!c) return err(404, 'not_found', 'Card not found');
    const missing = requiredMissing(c, getStage(codeWorkflowV1, 'build')!);
    if (missing.length) return err(422, 'missing_fields', 'Required fields are missing', { missing });
    transition(c, 'build', 'queued', 'specified');
    simulateBuilder(c);
    return HttpResponse.json(detail(c));
  }),
  http.post(`${A}/cards/:key/comments`, async ({ params, request }) => {
    const c = findCard(String(params.key));
    if (!c) return err(404, 'not_found', 'Card not found');
    const { body: text } = (await request.json()) as { body: string };
    const list = db.thread.get(c.id) ?? [];
    list.push({
      id: uuid(),
      threadId: c.id,
      authorKind: 'user',
      authorUserId: ME.id,
      authorAgentId: null,
      authorName: ME.displayName,
      kind: 'comment',
      body: text,
      data: {},
      createdAt: iso(),
    });
    db.thread.set(c.id, list);
    emit('ThreadMessagePosted', `thread-${c.id}`, c.projectId);
    return HttpResponse.json(detail(c), { status: 201 });
  }),
  http.post(`${A}/cards/:key/move`, async ({ params, request }) => {
    const c = findCard(String(params.key));
    const b = await body(request, MoveCardRequestSchema);
    if (!c || !b) return err(c ? 400 : 404, c ? 'validation' : 'not_found', 'Cannot move card');
    transition(c, b.toStage, b.toStage === 'spec' ? 'draft' : 'queued', b.reason);
    return HttpResponse.json(detail(c));
  }),
  http.post(`${A}/cards/:key/release`, ({ params }) => {
    const c = findCard(String(params.key));
    if (!c) return err(404, 'not_found', 'Card not found');
    transition(c, c.stage, 'queued', 'manual release');
    return HttpResponse.json(detail(c));
  }),
  http.post(`${A}/cards/:key/release-backoff`, ({ params }) => {
    const c = findCard(String(params.key));
    if (!c) return err(404, 'not_found', 'Card not found');
    c.backoff = null;
    return HttpResponse.json(detail(c));
  }),
  http.post(`${A}/cards/:key/cancel`, ({ params }) => {
    const c = findCard(String(params.key));
    if (!c) return err(404, 'not_found', 'Card not found');
    transition(c, c.stage, 'cancelled', 'cancelled by manager');
    return HttpResponse.json(detail(c));
  }),

  // agents
  http.get(`${A}/agents`, () => HttpResponse.json({ agents: db.agents.map(agentView) })),
  // M9 HR board: every agent with empty stats (no events to derive them from in the mock server)
  http.get(`${A}/hr/board`, () => {
    const none = { value: null, team: null };
    const now = iso();
    return HttpResponse.json({
      windowDays: 30,
      agents: db.agents
        .filter((a) => a.status !== 'retired')
        .map((a) => ({
          agent: agentView(a),
          hiredByName: ME.displayName,
          blockedOn: [],
          stats: {
            agentId: a.id,
            windowDays: 30,
            from: now,
            to: now,
            cardsTouched: 0,
            cardsDone: { value: 0, team: null },
            blockedRate: none,
            reworkRate: none,
            bugsEscaped: none,
            utilisation: { value: 0, team: null },
            tokensPerCard: none,
            doneByDay: Array.from({ length: 14 }, () => 0),
          },
          quality: {
            reviewScoreAvg: null,
            reviewCount: 0,
            reworkByReason: [],
            reworkRoundsPerCard: { avg: null, max: 0, cardsWithThreeOrMore: 0 },
            bugsEscaped: 0,
            criteriaMissed: 0,
            testCoverage: { cardsWithTests: 0, cardsMeasured: 0, rate: null },
          },
        })),
      recommendations: [],
      roleUpdates: [],
    });
  }),
  http.get(`${A}/agents/name-suggestions`, () => {
    const used = new Set(db.agents.map((a) => a.name));
    const pool = NAMES.filter((n) => !used.has(n));
    const start = (db.nameSeed++ * 3) % Math.max(1, pool.length);
    return HttpResponse.json({ names: [...pool.slice(start), ...pool.slice(0, start)].slice(0, 6) });
  }),
  http.post(`${A}/agents`, async ({ request }) => {
    const b = await body(request, HireAgentRequestSchema);
    if (!b) return err(400, 'validation', 'Invalid request');
    const role = roles.find((r) => r.key === b.roleKey);
    if (!role) return err(404, 'not_found', 'Role not found');
    if (db.agents.some((a) => a.name.toLowerCase() === b.name.toLowerCase()))
      return err(409, 'name_taken', 'That name is already used');
    const agent: AgentDto = {
      id: uuid(),
      orgId: ORG_ID,
      projectId: b.projectId ?? null,
      hiredByUserId: ME.id,
      managerUserId: ME.id,
      workstationId: b.workstationId,
      name: b.name,
      roleKey: b.roleKey,
      roleVersion: role.version,
      seniority: b.seniority,
      runtime: b.runtime ?? role.defaultModel.runtime,
      model: b.model ?? role.defaultModel.model,
      effort: b.effort ?? role.defaultModel.effort ?? null,
      skills: b.skills ?? [],
      permissions: role.permissions,
      capacity: b.capacity,
      isDevops: false,
      status: 'active',
      hiredAt: iso(),
      retiredAt: null,
      lastShiftEndedAt: null,
      activeCards: [],
    };
    db.agents.push(agent);
    emit('AgentHired', `agent-${agent.id}`, agent.projectId);
    for (const c of db.cards.filter((x) => x.stage === 'build' && x.status === 'queued')) simulateBuilder(c);
    return HttpResponse.json({ agent }, { status: 201 });
  }),
  http.post(`${A}/agents/:id/fire`, ({ params }) => {
    const a = db.agents.find((x) => x.id === params.id);
    if (!a) return err(404, 'not_found', 'Agent not found');
    for (const c of db.cards.filter((x) => x.claimedByAgentId === a.id))
      transition(c, c.stage, 'queued', 'agent retired');
    a.status = 'retired';
    a.retiredAt = iso();
    emit('AgentRetired', `agent-${a.id}`, a.projectId);
    return HttpResponse.json({ agent: a });
  }),
  http.get(`${A}/roles`, () =>
    HttpResponse.json({
      roles: roles.map((definition) => ({ definition, orgId: null, status: 'active', extensions: null })),
    }),
  ),
  http.get(`${A}/workflows`, () =>
    HttpResponse.json({
      workflows: workflows.map((definition) => ({ id: uuid(), orgId: null, status: 'active', definition })),
    }),
  ),
  ...extraHandlers,
];

function unlink(id: string) {
  const w = db.workstations.find((x) => x.id === id);
  if (!w) return err(404, 'not_found', 'Workstation not found');
  w.status = 'unlinked';
  w.connected = false;
  emit('WorkstationUnlinked', `workstation-${id}`, null);
  return HttpResponse.json({ ok: true });
}
