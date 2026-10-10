import type { MeResponse } from '@aom/shared';
import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useSyncExternalStore } from 'react';
import { meKey } from '../api/queries/auth.ts';

/**
 * True when the signed-in user turned on expert mode for version control (Settings). Off by default.
 *
 * It only reads the `me` the app shell already loaded (it never starts a request of its own), so a component that
 * shows or hides git controls can be rendered anywhere, also without a query client: it then shows simple mode.
 */
export function useExpertMode(): boolean {
  const client = useContext(QueryClientContext);
  return useSyncExternalStore(
    (notify) => (client ? client.getQueryCache().subscribe(notify) : () => {}),
    () => client?.getQueryData<MeResponse | null>(meKey)?.user?.gitExpert === true,
    () => false,
  );
}
