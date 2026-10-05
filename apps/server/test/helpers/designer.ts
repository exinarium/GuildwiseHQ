import { ok, type World } from './world.ts';

/** A custom role (a support triager) for the sample "support" workflow. */
export const roleInput = (
  key: string,
  stages: Array<[string, string]>,
  over: Record<string, unknown> = {},
) => ({
  key,
  name: key[0]?.toUpperCase() + key.slice(1),
  purpose: `Works ${key} stages of the support pipeline.`,
  department: 'support',
  instructions: `You are the ${key}. Do the work of your stage and report with the aom command.`,
  coreRules: ['Never promise refunds.'],
  seniorityLevels: ['junior', 'senior'],
  defaultModel: { runtime: 'mock', model: 'mock' },
  permissions: {
    allowedTools: ['read', 'shell'],
    deniedShellPatterns: [],
    writableGlobs: null,
    mayCommit: false,
    browser: false,
    riskTiers: ['small', 'large'],
    repoIds: null,
  },
  skills: [],
  claimableStages: stages.map(([workflowKey, stageId]) => ({ workflowKey, stageId })),
  ...over,
});

const outcome = (id: string, to: string, kind: 'success' | 'failure' = 'success', over = {}) => ({
  id,
  label: id,
  kind,
  to,
  event: 'StageCompleted',
  ...over,
});

/** intake (manual) -> triage (triager) -> resolve (responder) -> done; a failed resolve goes back to triage. */
export const workflowInput = (key = 'support', over: Record<string, unknown> = {}) => ({
  key,
  name: 'Support triage',
  department: 'support',
  fieldSet: 'custom',
  customFields: [{ key: 'customer', label: 'Customer', type: 'text', required: true }],
  cardTypes: ['support'],
  initialStage: 'intake',
  stages: [
    {
      id: 'intake',
      label: 'Intake',
      column: 'Intake',
      kind: 'manual',
      claimRole: null,
      doneCriteria: '',
      outcomes: [outcome('ready', 'triage', 'success', { event: 'CardSpecified' })],
    },
    {
      id: 'triage',
      label: 'Triage',
      column: 'Triage',
      kind: 'agent',
      claimRole: 'triager',
      requiredFields: ['customer'],
      doneCriteria: 'The ticket has a category and a priority.',
      outcomes: [outcome('triaged', 'resolve')],
    },
    {
      id: 'resolve',
      label: 'Resolve',
      column: 'Resolve',
      kind: 'agent',
      claimRole: 'responder',
      doneCriteria: 'The customer has an answer.',
      outcomes: [outcome('resolved', 'done'), outcome('escalate', 'triage', 'failure', { rework: true })],
    },
    {
      id: 'done',
      label: 'Done',
      column: 'Done',
      kind: 'terminal',
      claimRole: null,
      doneCriteria: '',
      outcomes: [],
    },
  ],
  ...over,
});

export const triagerRole = () => roleInput('triager', [['support', 'triage']]);
export const responderRole = () => roleInput('responder', [['support', 'resolve']]);

export interface Designed {
  cookie: string;
  q: string;
}

/** Drafts, submits and approves (on the desk) a role or workflow as the owner. */
export function designer(w: World, cookie = w.owner.cookie, projectQuery = '') {
  const req = (method: string, url: string, body?: unknown) =>
    w.t.req(method, `${url}${projectQuery}`, { cookie, body });
  const deskId = async (title: string) => {
    const desk = await ok<any>(w.t.req('GET', '/api/desk', { cookie }));
    return (desk.items as any[]).find((i) => i.title === title && i.status === 'open')?.id as
      | string
      | undefined;
  };
  return {
    req,
    async draft(kind: 'roles' | 'workflows', input: unknown) {
      return ok<any>(req('POST', `/api/${kind}`, input), 201);
    },
    async submit(kind: 'roles' | 'workflows', id: string) {
      return ok<any>(req('POST', `/api/${kind}/${id}/submit`));
    },
    async resolve(deskItemId: string, resolution: 'approved' | 'rejected', note?: string) {
      return w.t.req('POST', `/api/desk/${deskItemId}/resolve`, { cookie, body: { resolution, note } });
    },
    /** draft -> submit -> approve; returns the version id. */
    async publish(kind: 'roles' | 'workflows', input: unknown) {
      const d = await this.draft(kind, input);
      const s = await this.submit(kind, d.id);
      const r = await this.resolve(s.deskItemId, 'approved');
      if (r.status !== 200) throw new Error(`approve failed: ${r.status} ${JSON.stringify(r.body)}`);
      return d.id as string;
    },
    deskId,
  };
}
