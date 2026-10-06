import { randomUUID } from 'node:crypto';
import type { ThreadMessageKind } from '@aom/shared';
import { remoteUrlError, streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { badRequest } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';

export const projectScope = (orgId: string, projectId: string) =>
  ({ orgId, projectId, audience: 'project' }) as const;
export const orgScope = (orgId: string) => ({ orgId, projectId: null, audience: 'org' }) as const;
/** Per-user events (workstations, addressed items): only that user's browser receives them. */
export const userScope = (userId: string) =>
  ({ orgId: null, projectId: null, audience: 'user', userId }) as const;
export const userActor = (id: string) => ({ kind: 'user', id }) as const;
export const agentActor = (id: string) => ({ kind: 'agent', id }) as const;
export const runnerActor = (workstationId: string) => ({ kind: 'runner', id: workstationId }) as const;
export const SYSTEM_ACTOR = { kind: 'system', id: null } as const;

/** A `ThreadMessagePosted` for a card thread (thread id == card id). */
export function cardMessage(
  card: Record<string, any>,
  author: { kind: 'user'; userId: string } | { kind: 'agent'; agentId: string } | { kind: 'system' },
  kind: ThreadMessageKind,
  body: string,
  data: Record<string, unknown> = {},
): AppendInput {
  return {
    streamId: streamId.thread(card.id),
    event: {
      type: 'ThreadMessagePosted',
      payload: {
        threadId: card.id,
        messageId: randomUUID(),
        cardId: card.id,
        authorKind: author.kind,
        authorUserId: author.kind === 'user' ? author.userId : undefined,
        authorAgentId: author.kind === 'agent' ? author.agentId : undefined,
        kind,
        body,
        data,
      },
    },
    actor:
      author.kind === 'user'
        ? userActor(author.userId)
        : author.kind === 'agent'
          ? agentActor(author.agentId)
          : SYSTEM_ACTOR,
    scope: projectScope(card.org_id, card.project_id),
  };
}

/** Applies the deployment's remote policy (local paths only where the config allows them); the schema did the rest. */
export function assertRemoteUrl(ctx: Ctx, url: string): void {
  const err = remoteUrlError(url, ctx.config.allowLocalRemotes);
  if (err) throw badRequest('invalid_remote_url', err);
}
