// Adds what the guide's demo world lacks so the Phases and Interests screens are populated (idempotent).
//   node apps/web/scripts/ui-seed-extra.mjs      (same env as ui-shots.mjs)
import { request } from '/path/to/guildwise/e2e/node_modules/@playwright/test/index.mjs';

const origin = process.env.ORIGIN ?? 'http://localhost:4611';
const api = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
const login = await api.post('/api/auth/login', {
  data: {
    email: process.env.EMAIL ?? 'pieter@demo.local',
    password: process.env.PASSWORD ?? 'pieter-demo-pass-2026',
  },
});
if (!login.ok()) throw new Error(`login failed ${login.status()}`);
const j = async (p) => (await api.get(`/api${p}`)).json();
const { projects } = await j('/projects');
const web = projects.find((p) => p.key === 'WEB');
const news = projects.find((p) => p.workflowKey === 'feed');

if (web) {
  const existing = (await j(`/projects/${web.id}/phases`)).phases ?? [];
  if (existing.length === 0) {
    for (const name of ['Checkout polish', 'Returns and refunds']) {
      const r = await api.post(`/api/projects/${web.id}/phases`, {
        data: { name, description: `${name}: ship the related cards together, deploy and check.` },
      });
      if (!r.ok()) console.error('phase', name, r.status(), await r.text());
    }
    const phases = (await j(`/projects/${web.id}/phases`)).phases ?? [];
    const board = await j(`/board?projectId=${web.id}`);
    const cards = board.columns.flatMap((c) => c.cards);
    for (const [i, c] of cards.slice(0, 4).entries()) {
      const ph = phases[i % phases.length];
      if (ph) await api.post(`/api/cards/${c.id}/phase`, { data: { phaseId: ph.id } });
    }
  }
}
if (news) {
  const list = (await j('/interests')).interests ?? [];
  if (list.length === 0) {
    const r = await api.post('/api/interests', {
      data: {
        name: 'AI agents and coding assistants',
        description: 'Practical writing about agent tooling, evals and cost.',
        feedProjectId: news.id,
        scan: { cron: '0 7 * * *', timezone: 'Africa/Johannesburg', maxItems: 10 },
      },
    });
    if (!r.ok()) console.error('interest', r.status(), await r.text());
  }
}
console.log('seeded');
await api.dispose();
