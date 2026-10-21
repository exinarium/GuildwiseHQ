import type { ProbeRequest, SetupProbeDto } from '@aom/shared';
import { useState } from 'react';
import { useProbe } from '../../api/queries/deploy-setup.ts';

/**
 * Asks for a look (`deploy.probe`) and says when the answer that came back is a new one: the probe is a durable command, the
 * answer arrives in the setup state a moment later. `result` is the fresh answer for the last question asked.
 */
export function useProbeFlow(projectId: string, probes: SetupProbeDto[]) {
  const probe = useProbe(projectId);
  const [asked, setAsked] = useState<{
    scope: string;
    workstationId: string;
    host: string | null;
    before: string | null;
  } | null>(null);
  const find = (scope: string, workstationId: string, host: string | null) =>
    probes.find((p) => p.scope === scope && p.workstationId === workstationId && (p.host ?? null) === host);
  const ask = (req: ProbeRequest & { workstationId: string }) => {
    const host = req.scope === 'ssh_target' ? (req.host ?? null) : null;
    setAsked({
      scope: req.scope,
      workstationId: req.workstationId,
      host,
      before: find(req.scope, req.workstationId, host)?.id ?? null,
    });
    probe.mutate(req, { onError: () => setAsked(null) });
  };
  const current = asked ? find(asked.scope, asked.workstationId, asked.host) : undefined;
  const fresh = !!asked && !!current && current.id !== asked.before;
  const loading = !!asked && !fresh && !probe.isError;
  return { ask, loading, error: probe.error, result: fresh ? current : undefined, asked };
}
