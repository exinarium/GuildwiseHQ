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
        // scans and notes of an interest are cards (DigestPosted, ResearchPublished, CardCreated)
        ['interests'],
        ['interest'],
        // CardPhaseChanged and CardMergeVerified are on the card stream
        ['phases'],
        ['phase'],
      ];
    case 'phase':
    case 'ba':
      // Phase* events and the BA's background tasks
      return [
        ['phases'],
        ['phase'],
        ['board'],
        ['desk'],
        ['card'],
        ['thread', event.streamId.slice('phase-'.length)],
      ];
    case 'intake':
      return [['intakes'], ['desk'], ['card'], ['board']];
    case 'schedule':
      // ScheduleLinked adopts a schedule into an interest (or unlinks it); ScheduleFired changes an interest's stats
      return [['schedules'], ['board'], ['interests'], ['interest']];
    case 'interest':
      // Interest* events; the owner's schedule changes in the same append. An interest's events carry one project scope
      // (feed project, else research), so a member of only the other project gets no live update (the REST list is right).
      return [['interests'], ['interest'], ['schedules'], ['taste'], ['projects']];
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
      return [['card'], ['agents'], ['board'], ['hr'], ['metrics'], ['workstations']];
    case 'agent':
      return [['agents'], ['board'], ['card'], ['hr'], ['roles']];
    case 'role':
    case 'workflow':
    case 'departments':
      return [['roles'], ['workflows'], ['org'], ['hr'], ['agents'], ['projects'], ['board'], ['card']];
    case 'workstation':
      return [['workstations'], ['admin', 'workstations'], ['agents'], ['hr'], ['board'], ['card']];
    case 'project':
      return [
        ['projects'],
        ['project'],
        ['board'],
        ['project-invitations'],
        ['agents'],
        ['desk'],
        ['card'],
        // deploy targets and the default follow-ups live on the project stream
        ['deploy-targets'],
        ['followup-defaults'],
        ['phases'],
        // TasteSeedSet is on the project stream
        ['taste'],
        ['interests'],
        ['digest'],
      ];
    case 'user':
    case 'invitation':
      return [['admin'], ['me'], ['reporting']];
    default:
      return [];
  }
}

export function invalidateForEvent(qc: QueryClient, event: VisibleEvent): void {
  for (const key of keysForEvent(event)) void qc.invalidateQueries({ queryKey: key as unknown[] });
}
