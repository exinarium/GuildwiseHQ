/**
 * What one shift took to find its way in the code (docs/design/project-graphs.md section 11): the bytes and calls of the
 * search tools before the first edit, the bytes and calls of `aom graph`, and the size of the graph section in the
 * instructions. Counted by the runner from the runtime's tool stream, sent on `shift.ended` as numbers only, and read
 * together with the billed tokens by the server. Nothing in here names a file or a symbol.
 */
export interface ShiftContextMetrics {
  /** `on`: the shift had the graph; `off`: the holdout (nothing was offered); `none`: the project has no graph (not measured). */
  graphArm: 'on' | 'off' | 'none';
  /** Bytes returned by Read, Grep, Glob and search-like Bash commands before the first Write or Edit. */
  discoveryBytes: number;
  discoveryCalls: number;
  /** Bytes and calls of the `aom graph` verbs. */
  graphBytes: number;
  graphCalls: number;
  /** Bytes of the "Graph context" section in the instructions (0 when there was none). */
  briefBytes: number;
}

const DISCOVERY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Shell commands that look things up: a search, a listing, reading a file or a diff. */
const SEARCH_COMMAND =
  /^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:grep|egrep|fgrep|rg|ugrep|ag|ack|find|fd|ls|tree|cat|head|tail|wc|git\s+(?:grep|ls-files|show|log|diff|blame)|sed\s+-n)\b/;
const AOM_GRAPH = /^\s*aom\s+graph\b/;

/** Is this tool call a lookup in the code? (`aom graph` is counted on its own, not as discovery.) */
export function isDiscovery(name: string, summary: string): boolean {
  if (DISCOVERY_TOOLS.has(name)) return true;
  return name === 'Bash' && !AOM_GRAPH.test(summary) && SEARCH_COMMAND.test(summary);
}

export class ContextCounter {
  private open = true;
  private readonly calls = new Map<string, { name: string; summary: string }>();
  discoveryBytes = 0;
  discoveryCalls = 0;
  graphBytes = 0;
  graphCalls = 0;
  briefBytes = 0;

  constructor(private readonly arm: ShiftContextMetrics['graphArm']) {}

  /** A tool call started: the first edit closes the discovery phase. */
  onTool(id: string | undefined, name: string, summary: string): void {
    if (EDIT_TOOLS.has(name)) this.open = false;
    if (id) this.calls.set(id, { name, summary });
  }

  /** The tool's result arrived with `bytes` of text. */
  onResult(id: string, bytes: number): void {
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    if (!this.open || !isDiscovery(call.name, call.summary)) return;
    this.discoveryCalls++;
    this.discoveryBytes += bytes;
  }

  /** An `aom graph` verb was answered with `bytes` of text. */
  onGraphVerb(bytes: number): void {
    this.graphCalls++;
    this.graphBytes += bytes;
  }

  snapshot(): ShiftContextMetrics {
    return {
      graphArm: this.arm,
      discoveryBytes: this.discoveryBytes,
      discoveryCalls: this.discoveryCalls,
      graphBytes: this.graphBytes,
      graphCalls: this.graphCalls,
      briefBytes: this.briefBytes,
    };
  }
}
