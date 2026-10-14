import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The CEO acts with the Owner's rights, but the events say who did it (docs/design/ceo-agent-v2.md section 4.2): inside
 * `withActingAgent` every event appended with a `user` actor is stored with the CEO agent as its actor and the CEO action
 * as its `causation_id`. The existing command functions need no change, and the wake sources can tell the CEO's own
 * effects from the world's events.
 *
 * Timers and callbacks started inside inherit the context, so the context is switched off when the action is over: work
 * scheduled by it (the dispatcher's debounce) runs later as the system it is, not as the CEO.
 */
export interface ActingAgent {
  agentId: string;
  actionId: string;
}

interface Scope extends ActingAgent {
  active: boolean;
}

const store = new AsyncLocalStorage<Scope>();

export const actingAgent = (): ActingAgent | undefined => {
  const s = store.getStore();
  return s?.active ? s : undefined;
};

export async function withActingAgent<T>(a: ActingAgent, fn: () => Promise<T>): Promise<T> {
  const scope: Scope = { ...a, active: true };
  try {
    return await store.run(scope, fn);
  } finally {
    scope.active = false;
  }
}
