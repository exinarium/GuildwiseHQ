import { chatPreviewText } from '@aom/shared';
import { HttpResponse, http } from 'msw';
import { db, ME, ORG_ID } from './db.ts';

/**
 * Demo data for the chat screens in MSW dev mode (`VITE_MSW=1`): a CEO chat (standing + an earlier one), agent chats with
 * stored segments (tool rows, markdown), paging with `before`, `POST /chats/archive-all`, `POST /ceo/chat/new`, and a
 * scripted live turn for every `chat.send` (see `simulateTurn`). With `VITE_MSW_CEO=1` the mock user is the Owner of an
 * organization with a CEO, so the CEO entry points show.
 */
const A = '/api';
const iso = (minAgo = 0) => new Date(Date.now() - minAgo * 60_000).toISOString();
const id = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

const CEO_AGENT = id(900);
let standing = id(701);
const earlierCeo = id(700);
const adaAgent = id(901);
const boAgent = id(902);
const deeAgent = id(903);

interface MockChat {
  threadId: string;
  title: string;
  agentId: string;
  agentName: string;
  agentRole: string;
  projectId: null;
  cardId: string | null;
  cardRef: string | null;
  workstationOnline: boolean;
  createdAt: string;
  lastMessageAt: string | null;
  archived: boolean;
  mine: boolean;
}
const mk = (
  threadId: string,
  agentId: string,
  agentName: string,
  agentRole: string,
  lastMin: number | null,
  over: Partial<MockChat> = {},
): MockChat => ({
  threadId,
  title: `Chat with ${agentName}`,
  agentId,
  agentName,
  agentRole,
  projectId: null,
  cardId: null,
  cardRef: null,
  workstationOnline: true,
  createdAt: iso(5000),
  lastMessageAt: lastMin === null ? null : iso(lastMin),
  archived: false,
  mine: true,
  ...over,
});

const chats: MockChat[] = [
  mk(standing, CEO_AGENT, 'Cora', 'ceo', 3),
  mk(earlierCeo, CEO_AGENT, 'Cora', 'ceo', 60 * 30, { archived: true }),
  mk(id(702), adaAgent, 'Ada', 'builder', 12, { cardId: id(50), cardRef: 'TOY-5' }),
  mk(id(703), boAgent, 'Bo', 'reviewer', 60 * 5, { workstationOnline: false }),
  mk(id(704), deeAgent, 'Dee', 'ba', 60 * 26),
  mk(id(705), id(904), 'Eli', 'builder', null),
];

type Msg = {
  id: string;
  threadId: string;
  authorKind: 'user' | 'agent' | 'system';
  authorUserId: string | null;
  authorAgentId: string | null;
  authorName: string | null;
  kind: string;
  body: string;
  data: Record<string, unknown>;
  createdAt: string;
};
let n = 1000;
const msg = (
  threadId: string,
  kind: 'user' | 'agent',
  body: string,
  minAgo: number,
  data: Record<string, unknown> = {},
  agentId = adaAgent,
  name = 'Ada',
): Msg => ({
  id: id(n++),
  threadId,
  authorKind: kind,
  authorUserId: kind === 'user' ? ME.id : null,
  authorAgentId: kind === 'agent' ? agentId : null,
  authorName: kind === 'agent' ? name : null,
  kind: 'comment',
  body,
  data,
  createdAt: iso(minAgo),
});

const tool = (name: string, summary: string, status = 'ok') => ({ type: 'tool', name, summary, status });
const ADA_SEGMENTS = [
  { type: 'text', text: "I'll start by reading the login form and its tests, then fix the validation." },
  tool('Read', 'apps/web/src/pages/Login.tsx'),
  tool('Read', 'apps/web/src/test/login.test.tsx'),
  tool('Grep', 'validateEmail in apps/web/src'),
  tool('Edit', 'apps/web/src/pages/Login.tsx'),
  tool('Bash', 'pnpm --filter @aom/web test login'),
  {
    type: 'text',
    text: "## What I changed\n\nThe email check accepted `a@b` without a dot. Now it uses the shared validator.\n\n- Added `validateEmail` to the form\n- Added 2 tests\n\n| Check | Result |\n|---|---|\n| Unit tests | 14 passed |\n| Typecheck | clean |\n\n```ts\nif (!validateEmail(email)) {\n  setError('Enter a full email address');\n}\n```\n\nSee [the card](/cards/TOY-5) for details.",
  },
];
const threads = new Map<string, Msg[]>();
const ada = id(702);
threads.set(ada, [
  ...Array.from({ length: 60 }, (_, i) =>
    msg(
      ada,
      i % 2 ? 'agent' : 'user',
      i % 2 ? `Earlier answer ${i}` : `Earlier question ${i}`,
      3000 - i * 10,
    ),
  ),
  msg(ada, 'user', 'Can you fix the email validation on the login form?', 14),
  msg(ada, 'agent', 'ignored when segments exist', 12, { segments: ADA_SEGMENTS }),
]);
threads.set(standing, [
  msg(standing, 'user', "What's the status of my projects?", 6),
  msg(
    standing,
    'agent',
    '**Toy app**: 3 cards in progress, 1 waiting on you.\n\n1. TOY-5 login validation (in review)\n2. TOY-7 dark mode (building)\n\nWant me to nudge the reviewer?',
    3,
    { model: 'sonnet' },
    CEO_AGENT,
    'Cora',
  ),
]);
threads.set(earlierCeo, [
  msg(earlierCeo, 'user', 'Plan the Q4 release', 1800),
  msg(
    earlierCeo,
    'agent',
    'Here is a plan for the Q4 release.',
    1790,
    { model: 'sonnet' },
    CEO_AGENT,
    'Cora',
  ),
]);
threads.set(id(703), [msg(id(703), 'agent', 'Reviewed. Two nits left on the diff.', 300, {}, boAgent, 'Bo')]);
threads.set(id(704), [msg(id(704), 'user', 'Summarise yesterday', 1560)]);
threads.set(id(705), []);

const ceoState = (threadId: string) => ({
  threadId,
  agentName: 'Cora',
  workstation: { id: id(90), name: 'Pieter laptop', online: true },
  fullPower: { state: 'off', workstationName: null },
  model: {
    default: { runtime: 'claude-code', model: 'sonnet' },
    thread: null,
    runtimes: ['claude-code'],
  },
  cwd: '/home/ada',
  busy: false,
  queued: [],
  permissions: [],
  confirmations: [],
  corrections: [],
});

/** A workstation with every panel filled (Claude accounts, toolchains, git hosts) so the phone layout can be checked. */
const richWorkstations = () =>
  db.workstations.map((w, i) =>
    i > 0
      ? w
      : {
          ...w,
          userId: ME.id,
          runtimes: w.runtimes.map((r) =>
            r.id === 'claude-code'
              ? {
                  ...r,
                  accounts: [
                    {
                      key: 'main',
                      main: true,
                      configDir: '/home/ada/.claude',
                      email: 'ada@example.com',
                      plan: 'max',
                      login: 'ok',
                      usage: 'available',
                    },
                    {
                      key: 'client-acme-long-account-key',
                      main: false,
                      configDir: '/home/ada/.claude-accounts/client-acme-long-account-key',
                      email: 'ada.admin@acme-corporation.example',
                      plan: 'team',
                      login: 'expired',
                      usage: 'limited',
                      limitedUntil: iso(-90),
                    },
                  ],
                }
              : r,
          ),
          toolchains: {
            checkedAt: iso(2),
            items: [
              {
                name: 'dotnet',
                source: 'detected',
                version: '9.0.100',
                binDirs: ['/usr/share/dotnet'],
                readDirs: ['/usr/share/dotnet/sdk'],
                envKeys: [],
              },
              {
                name: 'go',
                source: 'devops',
                version: '1.23.2',
                binDirs: ['/home/ada/.aom/toolchains/go/bin'],
                readDirs: [],
                envKeys: ['GOROOT'],
                addedAt: iso(300),
                addedBy: 'devops',
              },
            ],
          },
          git: {
            checkedAt: iso(2),
            connections: [
              {
                provider: 'github',
                host: 'github.com',
                state: 'connected',
                account: 'ada',
                method: 'cli',
                checkedAt: iso(2),
              },
              {
                provider: 'gitlab',
                host: 'gitlab.internal.example.com',
                state: 'not_connected',
                checkedAt: iso(2),
              },
            ],
          },
        },
  );

export const chatHandlers = [
  http.get(`${A}/workstations`, () => HttpResponse.json({ workstations: richWorkstations() })),
  ...(import.meta.env.VITE_MSW_CEO === '1'
    ? [
        http.get(`${A}/auth/me`, () => {
          db.signedIn = true;
          return HttpResponse.json({
            user: ME,
            account: { kind: 'user' },
            isAdmin: true,
            orgs: [],
            activeOrg: {
              id: ORG_ID,
              name: 'Guildwise HQ',
              role: 'owner',
              status: 'active',
              plan: 'business',
              planName: 'Business',
              banners: [],
              features: {},
            },
            guestIn: [],
            guestProjectIds: [],
            pendingInvitations: 0,
            twoFactor: { enabled: false, required: false, setupRequired: false },
            mustChangePassword: false,
            visibleProjectIds: db.projects.map((p) => p.id),
            features: { mockUi: true },
          });
        }),
      ]
    : []),
  http.get(`${A}/ceo/status`, () =>
    HttpResponse.json({
      hired: true,
      state: 'active',
      offlineReason: null,
      isOwner: true,
      canPause: true,
      agent: {
        id: CEO_AGENT,
        name: 'Cora',
        avatarSeed: 'cora',
        avatarStyle: 'notionists',
        model: 'sonnet',
        runtime: 'claude-code',
        workstationId: id(90),
        workstationName: 'Pieter laptop',
      },
      scores: [],
      totals: { agreed: 0, total: 0 },
      pendingWakes: 0,
      waiting: null,
      running: null,
      lastError: null,
      openTasks: 0,
      spend: { currency: 'USD', todayMicros: 0, monthMicros: 0, orgMonthMicros: 0 },
      lastReportAt: null,
      policyVersion: 1,
      undone7d: { undone: 0, decided: 0 },
      fullPower: { state: 'off', workstationName: null },
      openRepeats: 0,
      workstations: [],
    }),
  ),
  http.get(`${A}/ceo/chat/state`, ({ request }) =>
    HttpResponse.json(ceoState(new URL(request.url).searchParams.get('threadId') ?? standing)),
  ),
  http.post(`${A}/ceo/chat/new`, () => {
    const old = chats.find((c) => c.threadId === standing);
    if (old) old.archived = true;
    standing = id(n++);
    chats.unshift(mk(standing, CEO_AGENT, 'Cora', 'ceo', null));
    threads.set(standing, []);
    return HttpResponse.json({ threadId: standing });
  }),
  http.post(`${A}/ceo/chat`, () => HttpResponse.json({ threadId: standing })),
  http.get(`${A}/chats`, () =>
    HttpResponse.json({
      chats: chats.map((c) => {
        const last = (threads.get(c.threadId) ?? []).at(-1);
        return {
          ...c,
          lastMessage: last
            ? { authorKind: last.authorKind, body: chatPreviewText(last.body), at: last.createdAt }
            : null,
        };
      }),
    }),
  ),
  http.post(`${A}/chats/archive-all`, async ({ request }) => {
    const b = (await request.json().catch(() => ({}))) as { exceptThreadIds?: string[] };
    let archived = 0;
    for (const c of chats)
      if (!c.archived && c.agentRole !== 'ceo' && !(b.exceptThreadIds ?? []).includes(c.threadId)) {
        c.archived = true;
        archived++;
      }
    return HttpResponse.json({ archived });
  }),
  http.post(`${A}/chats/:id/close`, ({ params }) => {
    const c = chats.find((x) => x.threadId === params.id);
    if (c) c.archived = true;
    return HttpResponse.json({ chat: c });
  }),
  http.post(`${A}/chats/:id/restore`, ({ params }) => {
    const c = chats.find((x) => x.threadId === params.id);
    if (c) c.archived = false;
    return HttpResponse.json({ chat: c });
  }),
  http.get(`${A}/threads/:id/messages`, ({ params, request }) => {
    const u = new URL(request.url);
    const limit = Number(u.searchParams.get('limit') ?? 50);
    const before = u.searchParams.get('before');
    const all = threads.get(String(params.id)) ?? [];
    const pool = before ? all.filter((m) => m.createdAt < before) : all;
    const page = pool.slice(-limit);
    return HttpResponse.json({
      threadId: params.id,
      kind: 'chat',
      messages: page,
      hasMore: pool.length > page.length,
    });
  }),
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A scripted turn: thinking, three tool calls, then streamed markdown, then `chat.done` with the stored message. */
export async function simulateTurn(threadId: string, body: string, clientMsgId: string): Promise<void> {
  const sock = db.socket;
  if (!sock) return;
  const list = threads.get(threadId) ?? [];
  list.push({ ...msg(threadId, 'user', body, 0), data: { clientMsgId } });
  threads.set(threadId, list);
  const chat = chats.find((c) => c.threadId === threadId);
  const isCeo = chat?.agentRole === 'ceo';
  const name = chat?.agentName ?? 'Ada';
  const agentId = chat?.agentId ?? adaAgent;
  const segs: unknown[] = [];
  const act = (seq: number, segment: unknown, replace = false) =>
    sock.handle({ type: 'chat.activity', threadId, seq, segment, ...(replace ? { replace: true } : {}) });
  await wait(500);
  act(0, { type: 'thinking' });
  await wait(800);
  for (const [i, [t, s]] of [
    ['Read', 'README.md'],
    ['Grep', 'TODO in apps/web'],
    ['Bash', 'pnpm test'],
  ].entries()) {
    const seg = { type: 'tool', id: `t${i}`, name: t, summary: s, status: 'running' };
    act(i + 1, seg);
    await wait(900);
    act(i + 1, { ...seg, status: 'ok' }, true);
    segs.push({ ...seg, status: 'ok' });
  }
  act(4, { type: 'text', text: '' });
  const text = `Here is what I found for **${body.slice(0, 40)}**:\n\n- The README is up to date\n- 2 TODOs remain\n- Tests pass\n\n\`\`\`bash\npnpm test\n\`\`\``;
  let sofar = '';
  for (const word of text.split(/(?<= )/)) {
    sofar += word;
    sock.handle({ type: 'chat.delta', threadId, text: word });
    await wait(40);
  }
  const stored = {
    ...msg(
      threadId,
      'agent',
      text,
      0,
      { ...(isCeo ? { model: 'sonnet' } : {}), segments: [...segs, { type: 'text', text: sofar }] },
      agentId,
      name,
    ),
  };
  list.push(stored);
  if (chat) chat.lastMessageAt = stored.createdAt;
  sock.handle({ type: 'chat.done', threadId, messageId: stored.id, message: stored });
}
