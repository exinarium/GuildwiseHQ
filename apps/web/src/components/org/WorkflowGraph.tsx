import type { WorkflowDefinition } from '@aom/shared';
import { type GraphEdge, type GraphNode, layoutWorkflow, NODE_H, NODE_W } from '../../lib/designer.ts';

const FILL: Record<GraphNode['kind'], string> = {
  agent: '#eef2ff',
  manual: '#fef9c3',
  terminal: '#dcfce7',
};

function edgePath(e: GraphEdge, a: GraphNode, b: GraphNode): string {
  if (e.back) {
    // A loop below the nodes, so rework and failure routes stay readable.
    const x1 = a.x + NODE_W / 2;
    const x2 = b.x + NODE_W / 2;
    const y = Math.max(a.y, b.y) + NODE_H;
    const dip = y + 22;
    return `M ${x1} ${y} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y}`;
  }
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

/** Graph preview of a workflow definition: stages as boxes, outcomes as arrows (failure routes dashed red). */
export function WorkflowGraph({
  def,
  flagged = new Set<string>(),
}: {
  def: Pick<WorkflowDefinition, 'initialStage' | 'stages'>;
  /** Stage ids that have validation errors. */
  flagged?: ReadonlySet<string>;
}) {
  const g = layoutWorkflow(def);
  const node = new Map(g.nodes.map((n) => [n.id, n]));
  return (
    <div className="overflow-x-auto" data-testid="workflow-graph">
      <svg
        role="img"
        aria-label="Workflow graph"
        width={g.width + 8}
        height={g.height + 8}
        viewBox={`-4 -4 ${g.width + 8} ${g.height + 8}`}
        className="text-zinc-700 dark:text-zinc-300"
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
          <marker
            id="arrow-fail"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#dc2626" />
          </marker>
        </defs>
        {g.edges.map((e) => {
          const a = node.get(e.from) as GraphNode;
          const b = node.get(e.to) as GraphNode;
          return (
            <path
              key={e.id}
              data-testid={`edge-${e.id}`}
              d={edgePath(e, a, b)}
              fill="none"
              stroke={e.failure ? '#dc2626' : 'currentColor'}
              strokeDasharray={e.failure ? '5 3' : undefined}
              strokeWidth={1.4}
              markerEnd={e.failure ? 'url(#arrow-fail)' : 'url(#arrow)'}
            />
          );
        })}
        {g.nodes.map((n) => (
          <g
            key={n.id}
            data-testid={`node-${n.id}`}
            data-unreachable={n.unreachable ? 'true' : undefined}
            transform={`translate(${n.x} ${n.y})`}
          >
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={8}
              fill={FILL[n.kind]}
              stroke={flagged.has(n.id) || n.unreachable ? '#dc2626' : '#71717a'}
              strokeWidth={flagged.has(n.id) || n.unreachable ? 2 : 1}
              strokeDasharray={n.unreachable ? '4 3' : undefined}
            />
            <text x={NODE_W / 2} y={19} textAnchor="middle" fontSize={12} fontWeight={600} fill="#18181b">
              {n.label.slice(0, 18)}
            </text>
            <text x={NODE_W / 2} y={35} textAnchor="middle" fontSize={10.5} fill="#52525b">
              {n.kind === 'agent' ? (n.role ?? 'no role yet') : n.kind}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
