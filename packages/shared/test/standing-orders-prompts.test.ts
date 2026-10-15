import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  devopsBriefOutcomes,
  renderBaTaskInstructions,
  renderBindingStandingOrders,
  renderChatInstructions,
  renderDevopsInstructions,
} from '../src/index.ts';
import { buildBrief, U } from './fixtures.ts';

// Backlog #75: the DevOps engineer, chats and BA tasks are briefed with the standing orders, as binding rules.

const ORDERS = [
  { title: 'Working Branch', body: 'Always use the repository working branch; never ask which one.' },
  { title: 'TOY: Lint first', body: 'Run the linter before every commit.' },
];
const devops = {
  requestId: U.c,
  threadId: U.c,
  summary: 'start the app',
  requestedBy: { kind: 'user' as const, id: U.d, name: 'Pieter' },
  workstationName: 'Desk',
  access: { allowInstall: true, allowDocker: false, allowedPaths: [], sudo: false },
  history: [],
};
const devopsBrief = (standingOrders = ORDERS) => ({
  ...buildBrief(),
  agent: { id: U.b, name: 'Atlas', seniority: 'senior' as const },
  shift: { ...buildBrief().shift, kind: 'devops' as const, outcomes: devopsBriefOutcomes() },
  standingOrders,
});

describe('binding standing orders section', () => {
  it('says the orders bind and override defaults, and lists each one', () => {
    const md = renderBindingStandingOrders(ORDERS);
    expect(md).toContain('# Standing orders');
    expect(md).toMatch(/standing order wins/);
    expect(md).toContain('## Working Branch\nAlways use the repository working branch');
    expect(md).toContain('## TOY: Lint first');
  });
  it('says None when there are none', () => {
    expect(renderBindingStandingOrders([])).toBe('# Standing orders\n\nNone.');
  });
});

describe('DevOps instructions carry the standing orders', () => {
  it('renders them between the core rules and the granted access', () => {
    const md = renderDevopsInstructions(devopsBrief(), devops);
    const rules = md.indexOf('# Core rules');
    const orders = md.indexOf('# Standing orders');
    const access = md.indexOf('# Granted access');
    expect(rules).toBeGreaterThan(-1);
    expect(orders).toBeGreaterThan(rules);
    expect(access).toBeGreaterThan(orders);
    expect(md).toContain('never ask which one');
    expect(md).toContain('Run the linter before every commit.');
  });
  it('the same holds for run and hygiene requests (one instructions file for every DevOps request)', () => {
    for (const extra of [{ hygiene: { trigger: 'manual' as const, repos: [] } }, {}]) {
      expect(renderDevopsInstructions(devopsBrief(), { ...devops, ...extra })).toContain('Working Branch');
    }
  });
  it('the DevOps role core rules put the standing orders above its defaults', () => {
    const role = BUILTIN_ROLES.find((r) => r.key === 'devops')!;
    expect(role.coreRules.join(' ')).toMatch(/standing orders .* binding and override/);
  });
});

describe('chat instructions carry the standing orders for every agent', () => {
  const ctx = { orgId: U.a, standingOrders: ORDERS };
  it('a builder chat', () => {
    const md = renderChatInstructions({ name: 'Vic', roleKey: 'builder', seniority: 'senior' }, ctx);
    expect(md).toContain('## Working Branch');
  });
  it('a DevOps chat (which gets no vault notes)', () => {
    const md = renderChatInstructions({ name: 'Atlas', roleKey: 'devops', seniority: 'senior' }, ctx);
    expect(md).toContain('## Working Branch');
    expect(md).toContain('## TOY: Lint first');
  });
  it('none: no section', () => {
    const md = renderChatInstructions(
      { name: 'Atlas', roleKey: 'devops', seniority: 'senior' },
      { orgId: U.a },
    );
    expect(md).not.toContain('# Standing orders');
  });
});

describe('BA phase task instructions carry the standing orders', () => {
  it('renders them', () => {
    const task = {
      kind: 'phase_report',
      phase: { ref: 'PH-1', name: 'Launch', projectKey: 'TOY' },
    } as never;
    const md = renderBaTaskInstructions({ ...buildBrief(), standingOrders: ORDERS }, task);
    expect(md).toContain('# Standing orders');
    expect(md).toContain('## Working Branch');
    expect(renderBaTaskInstructions({ ...buildBrief(), standingOrders: [] }, task)).not.toContain(
      '# Standing orders',
    );
  });
});
