import { ShiftsResponseSchema } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';

/** Every shift that has not ended and the user may see (the running-shift badges on Agents and Workstations). */
export function useRunningShifts(opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: ['shifts', 'active'],
    queryFn: async () => (await get('/shifts?active=1', ShiftsResponseSchema)).shifts,
    refetchInterval: 15_000,
  });
}

function useShiftAction<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of ['shifts', 'card', 'board', 'agents', 'workstations'])
        qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

/** Stops a shift; `keepCard` keeps the card with the same agent (a fresh shift starts), else it goes back in the queue. */
export const useStopShift = () =>
  useShiftAction((v: { shiftId: string; keepCard?: boolean }) =>
    post(`/shifts/${v.shiftId}/stop`, v.keepCard ? { keepCard: true } : {}),
  );

/** "Stop the running command": the shift goes on and the agent sees the command fail. */
export const useKillTools = () =>
  useShiftAction((shiftId: string) => post(`/shifts/${shiftId}/kill-tools`, {}));
