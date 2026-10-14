import type { IntegrationKind, IntegrationStatus } from '@aom/shared';
import type { PageCtx } from '../../lib/integrations.ts';
import { IntegrationTile } from './IntegrationTile.tsx';

/** One row per discovered plugin MCP server of this workstation (instances come from the runner's statuses). */
export function McpSignInList({
  ctx,
  kind,
  statuses,
  focusInstance,
  openConnect,
}: {
  ctx: PageCtx;
  kind: IntegrationKind;
  statuses: IntegrationStatus[];
  focusInstance: string | null;
  openConnect: boolean;
}) {
  if (statuses.length === 0)
    return (
      <p className="text-sm text-subtle" data-testid="mcp-empty">
        No plugin MCP servers found on {ctx.workstationName}. Install and enable a Claude Code plugin that
        provides one; the runner reports them every few minutes.
      </p>
    );
  return (
    <div className="flex flex-col gap-3" data-testid="mcp-list">
      {statuses.map((s) => (
        <IntegrationTile
          key={s.instance}
          ctx={ctx}
          kind={kind}
          instance={s.instance}
          status={s}
          title={s.instance}
          highlight={focusInstance === s.instance}
          openConnect={openConnect && focusInstance === s.instance}
        />
      ))}
    </div>
  );
}
