import type { CeoActionDto, CeoMemoryDtoApi, CeoStatusDto, DeskItemDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { vi } from 'vitest';
import { Ceo } from '../pages/Ceo.tsx';

export const U = (n: number) => `0192f3a0-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`;

export interface Call {
  method: string;
  url: string;
  body: unknown;
}
/** A route handler returns the JSON body, `null` for 204, or a `{ status, body }` pair for an error. */
export type Handler = (c: Call) => unknown;
export class Fail {
  constructor(
    readonly status: number,
    readonly message: string,
    readonly code = 'conflict',
  ) {}
}

export function meFor(role: 'owner' | 'admin' | 'member') {
  return {
    user: {
      id: U(1),
      email: 'p@x.test',
      displayName: 'Pieter',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
    },
    account: { kind: 'user' },
    isAdmin: false,
    activeOrg: {
      id: U(99),
      name: 'Acme',
      role,
      status: 'active',
      plan: 'business',
      planName: 'Business',
      banners: [],
      features: {},
    },
    orgs: [],
    visibleProjectIds: [],
  };
}

/** Stubs fetch: `routes` are matched on `METHOD /api/path` by prefix, first match wins. */
export function stubApi(role: 'owner' | 'admin' | 'member', routes: Array<[string, Handler]>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      if (call.url === '/api/auth/me') return jsonRes(meFor(role));
      calls.push(call);
      for (const [key, fn] of routes) {
        if (`${call.method} ${call.url}`.startsWith(key)) {
          const out = fn(call);
          if (out instanceof Fail)
            return jsonRes({ error: { code: out.code, message: out.message } }, out.status);
          if (out === null) return new Response(null, { status: 204 });
          return jsonRes(out);
        }
      }
      return jsonRes({ ok: true });
    }),
  );
  return calls;
}

export const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function wrap(node: ReactNode, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/org/ceo" element={node} />
          <Route path="/" element={node} />
          <Route path="*" element={<p data-testid="elsewhere">elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export const renderCeoPage = (query = '') => wrap(<Ceo />, `/org/ceo${query}`);

export function ceoStatus(over: Partial<CeoStatusDto> = {}): CeoStatusDto {
  return {
    hired: true,
    state: 'active',
    offlineReason: null,
    isOwner: true,
    canPause: true,
    agent: {
      id: U(20),
      name: 'Cora',
      avatarSeed: 'cora',
      avatarStyle: 'notionists',
      model: 'sonnet',
      runtime: 'claude-code',
      workstationId: U(90),
      workstationName: 'Pieter laptop',
    },
    training: {
      on: true,
      startedAt: '2026-10-05T00:00:00.000Z',
      until: '2026-10-19T00:00:00.000Z',
      graduatedAt: null,
      extensions: 0,
      daysLeft: 9,
    },
    scores: [
      { class: 'desk.answer_question', agreed: 12, total: 15 },
      { class: 'card.release', agreed: 6, total: 8 },
    ],
    totals: { agreed: 18, total: 23 },
    pendingWakes: 2,
    running: null,
    openTasks: 1,
    spend: { currency: 'USD', todayMicros: 1_200_000, monthMicros: 8_000_000, orgMonthMicros: 40_000_000 },
    lastReportAt: '2026-10-13T07:00:00.000Z',
    policyVersion: 1,
    undone7d: { undone: 1, decided: 20 },
    workstations: [
      { id: U(90), name: 'Pieter laptop', online: true, capable: true, current: true },
      { id: U(91), name: 'Studio PC', online: true, capable: true, current: false },
      { id: U(92), name: 'Old box', online: false, capable: false, current: false },
    ],
    ...over,
  };
}

export function action(n: number, over: Partial<CeoActionDto> = {}): CeoActionDto {
  return {
    id: U(40 + n),
    at: '2026-10-13T10:00:00.000Z',
    class: 'card.release',
    classLabel: 'Release or re-queue a card',
    action: 'release',
    mode: 'decided',
    status: 'done',
    subjectKind: 'card',
    subjectId: U(60 + n),
    subjectLabel: `TOY-${n}`,
    reason: `reason ${n}`,
    confidence: 0.9,
    evidence: ['ledger:abc'],
    policyVersion: 3,
    verdictReason: 'within the CEO policy',
    cause: null,
    untrusted: false,
    undo: { available: true, kind: 'inverse', label: `Release TOY-${n}`, reason: null },
    deskItemId: null,
    response: null,
    responseNote: null,
    responseChoice: null,
    undoneAt: null,
    acceptedFrom: null,
    ...over,
  };
}

export function memory(n: number, over: Partial<CeoMemoryDtoApi> = {}): CeoMemoryDtoApi {
  return {
    id: U(70 + n),
    kind: 'rule',
    scope: 'org',
    source: 'owner_statement',
    sourceRef: '',
    confidence: 0.9,
    status: 'active',
    observations: 1,
    class: null,
    text: `rule ${n}`,
    quote: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    lastConfirmedAt: '2026-10-02T00:00:00.000Z',
    ...over,
  };
}

export const deskItem = (over: Partial<DeskItemDto> = {}): DeskItemDto => ({
  id: U(50),
  kind: 'question',
  subkind: null,
  status: 'open',
  routedTo: 'manager',
  title: 'Tabs or spaces?',
  body: '',
  doing: '',
  options: [
    { id: 'o1', label: 'tabs' },
    { id: 'o2', label: 'spaces' },
  ],
  recommendation: null,
  blocking: false,
  pinned: false,
  urgent: false,
  affectedCardIds: [],
  affectedCount: 0,
  askedBy: { kind: 'agent', agentId: U(11), agentName: 'Ada', role: 'builder' },
  card: null,
  projectId: null,
  dedupEntries: [],
  answer: null,
  answerOption: null,
  answeredAt: null,
  answeredByName: null,
  decisionPolicy: 'owner_only',
  canAnswer: true,
  createdAt: '2026-10-13T10:00:00.000Z',
  ...over,
});
