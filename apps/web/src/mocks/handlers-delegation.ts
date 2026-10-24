import { HttpResponse, http } from 'msw';

/** Mock server for delegation grants (VITE_MSW=1 dev): off by default, a few personas to pick, grants kept in memory. */
const A = '/api';
type Grant = {
  targetKind: 'persona' | 'agent';
  targetKey: string;
  targetName: string;
  handle: string;
  maxCalls: number;
  timeoutSec: number;
  maxProfile: string | null;
  profile: string | null;
  model: string | null;
  problem: string | null;
  grantedAt: string;
  grantedBy: string | null;
};
const grants = new Map<string, Grant[]>();
const PERSONAS = [
  ['devils-advocate', "Devil's Advocate", 'Attacks edge cases and failure modes'],
  ['optimist', 'Optimist', 'Argues for the idea and its upside'],
  ['security-reviewer', 'Security reviewer', 'Looks for security problems'],
] as const;

const dto = (kind: 'agent' | 'session', id: string) => ({
  ownerKind: kind,
  ownerId: id,
  canManage: true,
  grants: grants.get(`${kind}:${id}`) ?? [],
});

const routes = (kind: 'agent' | 'session') => {
  const base = `${A}/${kind === 'agent' ? 'agents' : 'sessions'}/:id`;
  return [
    http.get(`${base}/delegate-grants`, ({ params }) => HttpResponse.json(dto(kind, String(params.id)))),
    http.get(`${base}/delegate-targets`, ({ params }) => {
      const have = new Set((grants.get(`${kind}:${params.id}`) ?? []).map((g) => g.targetKey));
      return HttpResponse.json({
        items: PERSONAS.map(([key, name, description]) => ({
          targetKind: 'persona',
          targetKey: key,
          name,
          description,
          model: null,
          profile: null,
          granted: have.has(key),
        })),
      });
    }),
    http.put(`${base}/delegate-grants`, async ({ params, request }) => {
      const b = (await request.json()) as {
        targetKind: 'persona' | 'agent';
        targetKey: string;
        grant: { maxCalls: number; timeoutSec: number; maxProfile: string | null } | null;
      };
      const k = `${kind}:${params.id}`;
      const rest = (grants.get(k) ?? []).filter((g) => g.targetKey !== b.targetKey);
      if (b.grant)
        rest.push({
          targetKind: b.targetKind,
          targetKey: b.targetKey,
          targetName: PERSONAS.find((p) => p[0] === b.targetKey)?.[1] ?? b.targetKey,
          handle: b.targetKey,
          maxCalls: b.grant.maxCalls,
          timeoutSec: b.grant.timeoutSec,
          maxProfile: b.grant.maxProfile,
          profile: null,
          model: null,
          problem: null,
          grantedAt: new Date().toISOString(),
          grantedBy: null,
        });
      grants.set(k, rest);
      return HttpResponse.json(dto(kind, String(params.id)));
    }),
  ];
};

export const delegationHandlers = [...routes('agent'), ...routes('session')];
