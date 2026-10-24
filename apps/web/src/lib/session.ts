import { useMe } from '../api/queries/auth.ts';
import { useWorkstations } from '../api/queries/workstations.ts';

/** The caller steers the session (creator, Owner or Admin). An older server that sends nothing means yes. */
export const canManageOf = (s: { canManage?: boolean | undefined }): boolean => s.canManage !== false;

export const TIME_LIMIT_PRESETS = [
  { value: '', label: 'No time limit' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '45', label: '45 minutes' },
  { value: '60', label: '1 hour' },
  { value: '90', label: '90 minutes' },
];

/** The workstations the signed-in user may run a session on: their own, active ones. Online first. */
export function useMyWorkstations(enabled = true) {
  const me = useMe();
  const ws = useWorkstations({ enabled });
  const myId = me.data?.user?.id;
  const list = (ws.data ?? [])
    .filter((w) => w.status !== 'unlinked' && (!myId || !w.userId || w.userId === myId))
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
  return { list, pending: ws.isPending };
}
