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
        // runs and notes of an interest are cards (DigestPosted, ResearchPublished, CardCreated): its list, detail and run log
        ['interests'],
        ['interest'],
        ['interest-runs'],
        ['interest-run'],
        // CardPhaseChanged and CardMergeVerified are on the card stream
        ['phases'],
        ['phase'],
        // ResearchPublished: the Research tab and the project's note count
        ['publications'],
        ['projects'],
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
      return [['schedules'], ['board']];
    case 'interest':
      // Interest* events (runs started, done or failed, deliveries, taste rules, archive and restore): the list, the
      // detail, the run log and the desk (a delivery puts a digest there). Their scope is the backing project.
      return [
        ['interests'],
        ['interest'],
        ['interest-runs'],
        ['interest-run'],
        ['interest-deliveries'],
        ['interest-agents'],
        ['digest'],
        ['desk'],
      ];
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
    case 'repo':
      // Repository requests (a conversion that waits for its repository): the project and the desk item change.
      return [['project'], ['projects'], ['desk'], ['board']];
    case 'project':
      return [
        ['publications'],
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
        ['interests'],
        ['digest'],
      ];
    case 'org':
      // Organization events reach Members payload-stripped: refetch everything that depends on the organization.
      return [
        ['me'],
        ['org'],
        ['orgs'],
        ['org-members'],
        ['org-invitations'],
        ['org-guests'],
        ['agents'],
        ['desk'],
        ['projects'],
        ['vaults'],
        ['hr'],
        ['roles'],
        ['reporting'],
        ['platform'],
      ];
    case 'user':
    case 'invitation':
      return [
        ['admin'],
        ['me'],
        ['reporting'],
        ['org-members'],
        ['org-invitations'],
        ['platform'],
        ['two-factor'],
      ];
    default:
      return [];
  }
}

export function invalidateForEvent(qc: QueryClient, event: VisibleEvent): void {
  for (const key of keysForEvent(event)) void qc.invalidateQueries({ queryKey: key as unknown[] });
}
