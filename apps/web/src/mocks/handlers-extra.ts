import { HttpResponse, http } from 'msw';
import { ME } from './db.ts';

/**
 * Stubs for the M2 to M6 pages (desk, chats, devops, vaults, ledger, schedules, feeds, testing) so `VITE_MSW=1` dev
 * does not error on them: collections are empty and mutations answer with a clear "not available" error.
 */
const A = '/api';
const empty = (body: Record<string, unknown>) => () => HttpResponse.json(body);
const unavailable = () =>
  HttpResponse.json(
    { error: { code: 'mock_unavailable', message: 'This action is not available in the mock server.' } },
    { status: 501 },
  );
const notFound = () =>
  HttpResponse.json(
    { error: { code: 'not_found', message: 'Not found in the mock server.' } },
    { status: 404 },
  );

let reporting = { routeViaBa: true, dailyAt: '08:00', timezone: 'UTC' as string | null };
const reportingBody = () => ({
  ...reporting,
  effectiveTimezone: reporting.timezone ?? 'UTC',
  canEdit: true,
});

export const extraHandlers = [
  // Part B: the BA as the manager's reporter (preferences and the manager's time zone).
  http.get(`${A}/reporting`, () => HttpResponse.json(reportingBody())),
  http.put(`${A}/auth/timezone`, async ({ request }) => {
    const { timezone } = (await request.json()) as { timezone: string };
    reporting = { ...reporting, timezone };
    return HttpResponse.json({
      user: { ...ME, timezone },
      isAdmin: true,
      visibleProjectIds: [],
      features: { mockUi: true },
    });
  }),
  http.put(`${A}/reporting`, async ({ request }) => {
    reporting = { ...reporting, ...((await request.json()) as object) };
    return HttpResponse.json(reportingBody());
  }),

  // M10 organization designer: built-in departments only; drafting needs the real server.
  http.get(`${A}/departments`, empty({ departments: [] })),
  http.post(`${A}/departments`, unavailable),
  http.get(`${A}/org/catalogue`, notFound),
  // M2 desk, ledger, chats
  http.get(`${A}/desk`, empty({ items: [], counts: { open: 0, blocking: 0, urgent: 0 } })),
  http.post(`${A}/desk/:id/answer`, unavailable),
  http.get(`${A}/ledger`, empty({ entries: [] })),
  http.post(`${A}/ledger`, unavailable),
  http.get(`${A}/chats`, empty({ chats: [] })),
  http.post(`${A}/chats`, unavailable),
  http.get(`${A}/threads/:id/messages`, notFound),
  // M7 intake
  http.get(`${A}/intakes`, empty({ intakes: [] })),
  http.get(`${A}/outbound`, empty({ drafts: [] })),
  http.get(`${A}/intakes/:id`, notFound),
  http.post(`${A}/intakes`, unavailable),
  // M3 devops and vaults
  http.get(`${A}/devops/requests`, empty({ requests: [] })),
  http.get(`${A}/devops/requests/:id`, notFound),
  http.post(`${A}/devops/requests`, unavailable),
  http.post(`${A}/devops/requests/:id/resolve`, unavailable),
  http.get(`${A}/vaults`, empty({ vaults: [] })),
  http.post(`${A}/vaults`, unavailable),
  http.patch(`${A}/vaults/:id`, unavailable),
  http.post(`${A}/vaults/:id/resolve-conflict`, unavailable),
  // M9 metrics
  http.get(
    `${A}/metrics`,
    empty({
      projectId: null,
      from: new Date(0).toISOString(),
      to: new Date(0).toISOString(),
      throughput: [],
      timeBlockedOnManager: { totalMs: 0, cards: 0, avgMsPerCard: null },
      bounceRate: [],
      bugsEscaped: { total: 0, byDay: [] },
      duration: { cards: 0, avgMsPerCard: null, medianMsPerCard: null, perAgent: [] },
      queueDepth: [],
    }),
  ),
  // Phases: none in the mock server; the pages show their empty states.
  http.get(`${A}/projects/:id/phases`, empty({ phases: [] })),
  http.get(`${A}/projects/:id/deploy-targets`, empty({ targets: [] })),
  http.get(`${A}/projects/:id/workstations`, empty({ workstations: [] })),
  http.get(`${A}/projects/:id/followup-defaults`, empty({ followups: [] })),
  http.post(`${A}/projects/:id/phases`, unavailable),
  http.post(`${A}/projects/:id/deploy-targets`, unavailable),
  http.put(`${A}/projects/:id/followup-defaults`, unavailable),
  http.get(`${A}/phases/by-number/:key/:number`, notFound),
  // M4 testing
  http.post(`${A}/cards/:key/finalize`, unavailable),
  http.post(`${A}/projects/:id/regression`, empty({ cards: [] })),
  // M5 schedules and feeds, M6 research
  http.get(`${A}/schedules`, empty({ schedules: [] })),
  http.post(`${A}/schedules`, unavailable),
  http.patch(`${A}/schedules/:id`, unavailable),
  http.delete(`${A}/schedules/:id`, unavailable),
  http.post(`${A}/schedules/:id/run`, unavailable),
  http.post(`${A}/projects/:id/feed/run`, unavailable),
  http.get(`${A}/projects/:id/feed`, empty({ path: 'feed/running-list.md', items: [] })),
  http.get(`${A}/projects/:id/taste`, empty({ path: 'feed/taste.md', content: '', lines: [] })),
  http.post(`${A}/digest-items/:id/rate`, unavailable),
  // Interests (docs/design/interests.md): an empty page in the mock runtime
  http.get(`${A}/interests`, empty({ interests: [], tasteProjects: [], adoptableCount: 0 })),
  http.get(`${A}/interests/adoptable`, empty({ schedules: [] })),
  http.get(`${A}/interests/:id`, notFound),
  http.post(`${A}/interests`, unavailable),
  http.post(`${A}/interests/adopt`, unavailable),
  http.patch(`${A}/interests/:id`, unavailable),
  http.delete(`${A}/interests/:id`, unavailable),
  http.post(`${A}/interests/:id/run`, unavailable),
  http.put(`${A}/interests/:id/taste`, unavailable),
  http.get(`${A}/projects/:id/taste-seed`, empty({ projectId: '', version: 0, rules: [], hasVault: false })),
  http.put(`${A}/projects/:id/taste-seed`, unavailable),
  http.post(`${A}/projects/:id/taste-seed/resync`, unavailable),
];
