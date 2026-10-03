import { HttpResponse, http } from 'msw';

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

export const extraHandlers = [
  // M2 desk, ledger, chats
  http.get(`${A}/desk`, empty({ items: [], counts: { open: 0, blocking: 0, urgent: 0 } })),
  http.post(`${A}/desk/:id/answer`, unavailable),
  http.get(`${A}/ledger`, empty({ entries: [] })),
  http.post(`${A}/ledger`, unavailable),
  http.get(`${A}/chats`, empty({ chats: [] })),
  http.post(`${A}/chats`, unavailable),
  http.get(`${A}/threads/:id/messages`, notFound),
  // M3 devops and vaults
  http.get(`${A}/devops/requests`, empty({ requests: [] })),
  http.get(`${A}/devops/requests/:id`, notFound),
  http.post(`${A}/devops/requests`, unavailable),
  http.post(`${A}/devops/requests/:id/resolve`, unavailable),
  http.get(`${A}/vaults`, empty({ vaults: [] })),
  http.post(`${A}/vaults`, unavailable),
  http.patch(`${A}/vaults/:id`, unavailable),
  http.post(`${A}/vaults/:id/resolve-conflict`, unavailable),
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
];
