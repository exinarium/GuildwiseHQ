// Shared by ui-shots.mjs and ui-a11y.mjs: logs in over the API and discovers the routes of the demo world.
import { request } from '/path/to/guildwise/e2e/node_modules/@playwright/test/index.mjs';

export const base = process.env.BASE ?? 'http://127.0.0.1:5199';
export const apiOrigin = process.env.ORIGIN ?? 'http://localhost:4611';
export const email = process.env.EMAIL ?? 'pieter@demo.local';
export const password = process.env.PASSWORD ?? 'pieter-demo-pass-2026';

export async function connect() {
  const api = await request.newContext({ baseURL: apiOrigin, extraHTTPHeaders: { Origin: apiOrigin } });
  const login = await api.post('/api/auth/login', { data: { email, password } });
  if (!login.ok()) throw new Error(`login failed: ${login.status()}`);
  const storageState = await api.storageState();
  const j = async (p) => (await api.get(`/api${p}`)).json();
  return { api, storageState, j, routes: await discover(j) };
}

async function discover(j) {
  const { projects } = await j('/projects');
  const web = projects.find((p) => p.key === 'WEB') ?? projects.find((p) => p.workflowKey === 'code');
  const feed = projects.find((p) => p.workflowKey === 'feed');
  const research = projects.find((p) => p.workflowKey === 'research');
  const board = await j(`/board?projectId=${web.id}`);
  const cards = board.columns.flatMap((c) => c.cards);
  const pick = (col) => board.columns.find((c) => c.name === col)?.cards[0];
  const detailCard = pick('Blocked') ?? pick('Review') ?? cards[0];
  const intakes = (await j('/intakes')).intakes ?? [];
  let phase = null;
  try {
    const ph = (await j(`/projects/${web.id}/phases`)).phases ?? [];
    phase = ph[0] ?? null;
  } catch {}

  return {
    projects: '/projects',
    board: `/p/${web.key}/board`,
    desk: '/desk',
    'card-new': `/cards/new?project=${web.key}`,
    'card-detail': `/cards/${detailCard.ref}`,
    agents: '/agents',
    workstations: '/workstations',
    ledger: '/ledger',
    vaults: '/settings/vaults',
    org: '/org',
    'org-workflows': '/org?tab=workflows',
    schedules: '/schedules',
    metrics: '/metrics',
    admin: '/admin',
    intake: '/intake',
    settings: '/settings',
    interests: '/interests',
    'project-settings': `/projects/${web.id}/settings`,
    ...(feed ? { feed: `/p/${feed.key}/feed`, 'board-feed': `/p/${feed.key}/board` } : {}),
    ...(research
      ? {
          'board-research': `/p/${research.key}/board`,
          'project-settings-research': `/projects/${research.id}/settings`,
        }
      : {}),
    ...(intakes[0] ? { 'intake-view': `/intake/${intakes[0].id}` } : {}),
    ...(phase ? { phase: `/p/${web.key}/phases/${phase.number}` } : {}),
  };
}
