import { type AgentMayDo, GATE_CLASSES, GATE_INFO } from '@aom/shared';
import { HttpResponse, http } from 'msw';

/** Mock server for "What it may do", the approval gates, the notification confirm page and the audit export (VITE_MSW=1 dev). */
const A = '/api';
const gated = new Map<string, Set<string>>();

const mayDo = (id: string): AgentMayDo => ({
  agentId: id,
  agentName: 'Agent',
  tools: {
    allowedTools: ['read', 'edit', 'shell'],
    deniedShellPatterns: ['git push*', 'rm -rf /*'],
    writableGlobs: null,
    mayCommit: true,
    browser: false,
    riskTiers: ['small', 'large'],
  },
  repos: { readOrgRepos: false, repos: null },
  data: { projects: null, mcpServers: [] },
  provider: {
    runtime: 'claude-code',
    model: 'sonnet',
    effort: null,
    workstation: 'Dev box',
    keySource: 'login',
  },
  delegation: [],
  playbooks: [],
  skills: [],
  packs: [],
  spend: { currency: 'USD', monthMicros: 3_200_000, totalMicros: 18_900_000, budgets: [] },
  gates: GATE_CLASSES.map((c) => ({
    actionClass: c,
    label: GATE_INFO[c].label,
    description: GATE_INFO[c].description,
    enforcement: GATE_INFO[c].enforcement,
    note: GATE_INFO[c].note,
    gated: GATE_INFO[c].enforcement === 'always' || (gated.get(id)?.has(c) ?? false),
    pending: 0,
  })),
  canGate: true,
  canUngate: true,
});

export const governanceHandlers = [
  http.get(`${A}/agents/:id/may-do`, ({ params }) => HttpResponse.json(mayDo(String(params.id)))),
  http.put(`${A}/agents/:id/gates`, async ({ params, request }) => {
    const id = String(params.id);
    const b = (await request.json()) as { actionClass: string; gated: boolean };
    const set = gated.get(id) ?? new Set<string>();
    if (b.gated) set.add(b.actionClass);
    else set.delete(b.actionClass);
    gated.set(id, set);
    return HttpResponse.json(mayDo(id));
  }),
  http.get(`${A}/m/desk/:token`, () =>
    HttpResponse.json({
      state: 'ready',
      deskItemId: '0192f3a0-0000-7000-8000-000000000088',
      title: 'Allow Mia to run the playbook "Brainstorm"?',
      body: 'Mia wants to run the playbook "Brainstorm". Approve to let its next attempt go through.',
      orgName: 'Demo organization',
      actionLabel: 'Approve',
      action: 'approve',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    }),
  ),
  http.post(`${A}/m/desk/:token/apply`, () =>
    HttpResponse.json({
      deskItemId: '0192f3a0-0000-7000-8000-000000000088',
      outcome: 'approved',
      actionLabel: 'Approve',
    }),
  ),
  http.get(`${A}/org/audit/export`, ({ request }) => {
    const csv = new URL(request.url).searchParams.get('format') !== 'json';
    return new HttpResponse(csv ? 'at,type\r\n' : '[]\n', {
      headers: {
        'content-type': csv ? 'text/csv' : 'application/json',
        'content-disposition': `attachment; filename="audit-demo.${csv ? 'csv' : 'json'}"`,
      },
    });
  }),
];
