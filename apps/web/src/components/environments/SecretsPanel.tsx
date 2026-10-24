import type { DeliverySettingsResponse } from '@aom/shared';
import { useState } from 'react';
import { useSetDeploySecret } from '../../api/queries/delivery.ts';
import { useProjectWorkstations } from '../../api/queries/phases.ts';
import { canSealHere } from '../../lib/secure.ts';
import { formatDateTime } from '../../lib/time.ts';
import { SecureContextNotice } from '../SecureContextNotice.tsx';
import { Button, Callout, ErrorBox, Select, TextInput, useToast } from '../ui.tsx';

/** Secrets the recipe names: set the value on one of your workstations. It is encrypted here for the runner and never reaches Guildwise. */
export function DeliverySecrets({ projectId, d }: { projectId: string; d: DeliverySettingsResponse }) {
  const names = [...new Set((d.environments ?? []).flatMap((e) => e.secrets))];
  const ws = useProjectWorkstations(projectId);
  const mine = (ws.data ?? []).filter((w) => w.mine);
  const set = useSetDeploySecret(projectId);
  const toast = useToast();
  const [wsId, setWsId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  if (names.length === 0) return null;
  const target = wsId || mine[0]?.id || '';
  const held = (n: string) => d.secrets.find((s) => s.workstationId === target && s.name === n);
  return (
    <div className="mt-4 border-t border-line pt-3" data-testid="delivery-secrets">
      <p className="mb-1 text-xs font-medium text-muted">Secrets the recipe names</p>
      <Callout tone="info" className="mb-2">
        A value is encrypted in your browser for the runner of the workstation you choose and kept only there.
        Guildwise never sees it, and it is hidden from every log.
      </Callout>
      <SecureContextNotice className="mb-2" />
      {mine.length > 1 && (
        <Select label="On workstation" value={target} onChange={(e) => setWsId(e.target.value)}>
          {mine.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      )}
      {names.map((n) => {
        const h = held(n);
        return (
          <div key={n} className="mt-2 flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <TextInput
                label={n}
                type="password"
                autoComplete="off"
                value={values[n] ?? ''}
                placeholder={h ? 'set: type to replace' : 'not set on this workstation'}
                hint={h ? `Set ${formatDateTime(h.setAt)}` : undefined}
                data-testid={`deploy-secret-${n}`}
                onChange={(e) => setValues((c) => ({ ...c, [n]: e.target.value }))}
              />
            </div>
            <Button
              disabled={!values[n] || !target || !canSealHere()}
              loading={set.isPending}
              data-testid={`deploy-secret-save-${n}`}
              onClick={() =>
                set.mutate(
                  { workstationId: target, name: n, value: values[n] ?? '' },
                  {
                    onSuccess: () => {
                      setValues((c) => ({ ...c, [n]: '' }));
                      toast.success(`${n} sent to the workstation`);
                    },
                  },
                )
              }
            >
              Set {n}
            </Button>
          </div>
        );
      })}
      <ErrorBox error={set.error} />
    </div>
  );
}
