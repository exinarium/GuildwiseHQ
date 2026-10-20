import {
  Bot,
  Check,
  ChevronRight,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  Loader2,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { type ChatSegment, COLLAPSE_AT, type ToolKind, toolKind, toolLabel } from '../../lib/chatSegments.ts';
import { cx } from '../ui/cx.ts';

type Tool = Extract<ChatSegment, { type: 'tool' }>;

const ICONS: Record<ToolKind, typeof Wrench> = {
  read: FileText,
  edit: FilePen,
  write: FilePlus,
  bash: SquareTerminal,
  search: Search,
  web: Globe,
  mcp: Plug,
  task: Bot,
  other: Wrench,
};

function StatusMark({ status }: { status: Tool['status'] }) {
  if (status === 'running')
    return <Loader2 aria-label="Running" role="img" className="size-3.5 animate-spin text-muted" />;
  if (status === 'error') return <X aria-label="Failed" role="img" className="size-3.5 text-danger" />;
  if (status === 'refused')
    return (
      <span className="rounded-full bg-warning-soft px-1.5 py-px text-[10px] font-medium text-warning-soft-fg">
        refused
      </span>
    );
  return <Check aria-label="Done" role="img" className="size-3.5 text-success" />;
}

/** One tool call: icon by kind, name, one-line summary, status. */
export function ToolRow({ tool }: { tool: Tool }) {
  const Icon = ICONS[toolKind(tool.name)];
  return (
    <div
      data-testid="tool-row"
      data-status={tool.status}
      title={tool.summary ?? toolLabel(tool.name)}
      className="flex min-h-7 items-center gap-2 rounded-control px-2 py-1 text-sm"
    >
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
      <span className="shrink-0 font-medium text-fg">{toolLabel(tool.name)}</span>
      {tool.summary && (
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{tool.summary}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center pl-1">
        <StatusMark status={tool.status} />
      </span>
    </div>
  );
}

/** The tool rows of one stretch of a turn: 1 or 2 show inline, 3 or more collapse behind "Used N tools". */
export function ToolGroup({ tools }: { tools: Tool[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.filter((t) => t.status === 'running');
  const failed = tools.filter((t) => t.status === 'error' || t.status === 'refused').length;
  if (tools.length < COLLAPSE_AT)
    return (
      <div
        className="flex flex-col rounded-card border border-line bg-surface py-0.5"
        data-testid="tool-group"
      >
        {tools.map((t, i) => (
          <ToolRow key={t.id ?? i} tool={t} />
        ))}
      </div>
    );
  const last = tools[tools.length - 1];
  return (
    <div className="rounded-card border border-line bg-surface" data-testid="tool-group">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center gap-2 rounded-card px-2.5 py-1 text-left text-sm text-muted hover:bg-sunken md:min-h-9"
      >
        <ChevronRight aria-hidden="true" className={cx('size-4 transition-transform', open && 'rotate-90')} />
        <span className="font-medium text-fg">Used {tools.length} tools</span>
        {failed > 0 && <span className="text-xs text-danger">{failed} failed</span>}
        <span className="ml-auto">
          {running.length > 0 ? (
            <Loader2 aria-label="Running" role="img" className="size-3.5 animate-spin" />
          ) : (
            failed === 0 && <Check aria-label="Done" role="img" className="size-3.5 text-success" />
          )}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col border-t border-line py-0.5">
          {tools.map((t, i) => (
            <ToolRow key={t.id ?? i} tool={t} />
          ))}
        </div>
      ) : (
        // While it works, the newest running tool stays visible under the collapsed header.
        running.length > 0 &&
        last && (
          <div className="border-t border-line py-0.5">
            <ToolRow tool={running[running.length - 1] ?? last} />
          </div>
        )
      )}
    </div>
  );
}
