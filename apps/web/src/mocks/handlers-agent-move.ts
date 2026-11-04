import { HttpResponse, http } from 'msw';

/**
 * Mock server for moving all agents off an offline or removed workstation (`VITE_MSW=1` dev): one removed workstation
 * with four agents, two targets, and a mixed preview (will move, one DevOps engineer, a limit and a running shift).
 */
const A = '/api';
const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SOURCE = ID(900);
const TARGET = ID(901);
const ref = (n: number, name: string) => ({ agentId: ID(910 + n), name });

const preview = (dryRun: boolean) => ({
  dryRun,
  scope: 'all',
  source: { id: SOURCE, name: 'My workstation', status: 'unlinked', connected: false },
  target: { id: TARGET, name: 'Desk' },
  moved: [{ ...ref(1, 'Una'), releasedClaims: ['GWP-12'] }],
  blocked: [
    {
      ...ref(2, 'Devon'),
      reason: 'one_devops',
      code: 'one_devops_per_workstation',
      message:
        'Desk already has a DevOps engineer, Dina: the rule is one DevOps engineer per workstation (agents_one_devops), so Devon cannot move there.',
    },
    {
      ...ref(3, 'Busy'),
      reason: 'running_shift',
      code: 'agent_busy',
      message: 'Busy is in a running shift: wait until it ends or stop it, then move Busy.',
    },
    {
      ...ref(4, 'Late'),
      reason: 'workstation_limit',
      code: 'limit_reached',
      message: 'The organization is at its workstation limit.',
    },
  ],
  needsUnsandboxedAck: false,
});

export const agentMoveHandlers = [
  http.get(`${A}/agents/workstations`, () =>
    HttpResponse.json({
      workstations: [
        {
          id: SOURCE,
          name: 'My workstation',
          status: 'unlinked',
          connected: false,
          ownerName: 'You',
          mine: true,
          agentCount: 4,
          runningCount: 1,
        },
      ],
    }),
  ),
  http.get(`${A}/workstations/:id/move-targets`, () =>
    HttpResponse.json({
      current: { id: SOURCE, name: 'My workstation', state: 'unpaired' },
      workstations: [
        {
          id: TARGET,
          name: 'Desk',
          ownerUserId: ID(1),
          ownerName: 'You',
          mine: true,
          connected: true,
          runtimes: [],
          devops: null,
        },
      ],
    }),
  ),
  http.get(`${A}/workstations/:id/move-agents/preview`, () => HttpResponse.json(preview(true))),
  http.post(`${A}/workstations/:id/move-agents`, () => HttpResponse.json(preview(false))),
];
