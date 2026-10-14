import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The CEO acts with the Owner's rights, but the events say who did it (docs/design/ceo-agent-v2.md section 4.2): inside
 * `withActingAgent` every event appended with a `user` actor is stored with the CEO agent as its actor and the CEO action
 * as its `causation_id`. The existing command functions need no change, and the wake sources can tell the CEO's own
 * effects from the world's events.
 */
export interface ActingAgent {
  agentId: string;
  actionId: string;
}

const store = new AsyncLocalStorage<ActingAgent>();

export const actingAgent = (): ActingAgent | undefined => store.getStore();
export const withActingAgent = <T>(a: ActingAgent, fn: () => Promise<T>): Promise<T> => store.run(a, fn);
