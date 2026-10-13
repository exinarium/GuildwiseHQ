import type { WorkstationDto } from '@aom/shared';
import { useMe } from '../../api/queries/auth.ts';
import { useRemoveToolchain } from '../../api/queries/workstations.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Button, ErrorBox } from '../ui.tsx';

const SOURCE_LABEL = { detected: 'detected', devops: 'added by DevOps', config: 'from config' } as const;

/**
 * "Agent toolchains": the tools the sandboxed agents of this workstation can use (.NET SDKs, Node, Go, ...), with the
 * folder, where each came from and, for the ones the DevOps engineer registered with `aom toolchain add`, a Remove for
 * the workstation's owner. Detected and configured ones are listed but not removable here. Owner only.
 */
export function AgentToolchains({ w }: { w: WorkstationDto }) {
  const me = useMe();
  const remove = useRemoveToolchain();
  const mine = !!me.data && w.userId === me.data.user.id;
  if (!mine || !w.toolchains) return null;
  const { items, checkedAt } = w.toolchains;
  return (
    <div className="mt-4 border-t border-line pt-3 text-sm" data-testid="agent-toolchains">
      <p className="mb-1 text-xs font-medium text-subtle">Agent toolchains</p>
      <p className="mb-2 text-muted">
        Tools the sandboxed agents can use. If one is missing, ask the DevOps engineer to install it and
        register it.
      </p>
      {!checkedAt && <p className="mb-2 text-subtle">Not reported yet (needs a current runner).</p>}
      {checkedAt && items.length === 0 && <p className="text-subtle">None detected or registered.</p>}
      <ul className="flex flex-col gap-1.5">
        {items.map((t) => (
          <li key={t.name} className="flex flex-wrap items-center gap-2" data-testid={`toolchain-${t.name}`}>
            <span className="font-medium text-fg">{t.name}</span>
            {t.version && <span className="text-muted">{t.version}</span>}
            <Badge tone={t.source === 'devops' ? 'blue' : 'neutral'}>{SOURCE_LABEL[t.source]}</Badge>
            <span className="font-mono text-xs break-all text-subtle">
              {[...t.binDirs, ...t.readDirs.filter((r) => !t.binDirs.includes(r))].join(', ')}
            </span>
            {t.addedAt && (
              <span className="text-xs text-subtle">
                {t.addedBy === 'devops' ? 'added by DevOps on ' : 'added on '}
                {formatDateTime(t.addedAt)}
              </span>
            )}
            {t.source === 'devops' && (
              <Button
                size="sm"
                variant="secondary"
                disabled={remove.isPending}
                aria-label={`Remove the toolchain ${t.name} from ${w.name}`}
                onClick={() => remove.mutate({ workstationId: w.id, name: t.name })}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      <ErrorBox error={remove.error} />
    </div>
  );
}
