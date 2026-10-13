import type { CardMcpUsage } from '@aom/shared';
import { Panel } from './ui.tsx';

/** The external (MCP) tools the card's agents called, per shift: server and tool names with counts. */
export function McpUsagePanel({ usage }: { usage: readonly CardMcpUsage[] }) {
  if (usage.length === 0) return null;
  return (
    <Panel title="External tools used" data-testid="mcp-usage">
      <ul className="flex flex-col gap-3 text-sm">
        {usage.map((s) => (
          <li key={s.shiftId}>
            <p className="font-medium">
              {s.agentName ?? 'An agent'}
              {s.stage ? ` (${s.stage})` : ''}{' '}
              <span className="font-normal text-subtle">{new Date(s.startedAt).toLocaleString()}</span>
            </p>
            <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
              {s.calls.map((c) => (
                <li key={`${c.server}|${c.tool}`}>
                  {c.server} / {c.tool} <span className="text-subtle">x{c.count}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
