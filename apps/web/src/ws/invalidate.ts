import type { VisibleEvent } from '@aom/shared';
import type { QueryClient } from '@tanstack/react-query';

type Keys = ReadonlyArray<readonly unknown[]>;

/**
 * Maps a visible event to the TanStack Query keys it makes stale (docs/ARCHITECTURE.md section 20). No client-side
 * event projection: we only refetch. Card queries are keyed by ref or id, so the whole `card` prefix is invalidated.
 */
export function keysForEvent(event: Pick<VisibleEvent, 'type' | 'streamId' | 'projectId'>): Keys {
  const kind = event.streamId.split('-')[0];
  switch (kind) {
    case 'card':
      return [
        event.projectId ? ['board', event.projectId] : ['board'],
        ['card'],
        ['agents'],
        ['digest'],
        ['intakes'],
        ['hr'],
        ['metrics'],
      ];
    case 'intake':
      return [['intakes'], ['desk'], ['card'], ['board']];
    case 'schedule':
      return [['schedules'], ['board']];
    case 'thread':
      // Card threads show on the card; chat threads have their own message list and the chat list.
      return [
        ['card'],
        ['devops'],
        ['thread', event.streamId.slice('thread-'.length)],
        ['chats'],
        ['intakes'],
      ];
    case 'desk':
      // Questions block and unblock cards; answers add ledger entries.
      return [
        ['desk'],
        ['board'],
        ['card'],
        ['ledger'],
        ['devops'],
        ['vaults'],
        ['intakes'],
        ['hr'],
        ['metrics'],
      ];
    case 'outbound':
      return [['outbound'], ['desk'], ['card']];
    case 'ledger':
      return [['ledger'], ['desk'], ['card']];
    case 'vault':
      return [['vaults']];
    case 'shift':
      return [['card'], ['agents'], ['board'], ['hr'], ['metrics']];
    case 'agent':
      return [['agents'], ['board'], ['card'], ['hr'], ['roles']];
    case 'role':
    case 'workflow':
    case 'departments':
      return [['roles'], ['workflows'], ['org'], ['hr'], ['agents'], ['projects']];
    case 'workstation':
      return [['workstations'], ['admin', 'workstations'], ['agents']];
    case 'project':
      return [['projects'], ['project'], ['board'], ['project-invitations'], ['agents']];
    case 'user':
    case 'invitation':
      return [['admin'], ['me']];
    default:
      return [];
  }
}

export function invalidateForEvent(qc: QueryClient, event: VisibleEvent): void {
  for (const key of keysForEvent(event)) void qc.invalidateQueries({ queryKey: key as unknown[] });
}
