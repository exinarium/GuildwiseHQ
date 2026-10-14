import { readdirSync, readFileSync } from 'node:fs';

/** Reads `/proc` (Linux and WSL2). Injectable so the walk can be tested without real processes. */
export interface ProcReader {
  pids(): number[];
  /** `ppid` and `comm` of a process, undefined when it is gone. */
  stat(pid: number): { ppid: number; comm: string } | undefined;
}

export const realProc: ProcReader = {
  pids() {
    try {
      return readdirSync('/proc')
        .filter((n) => /^\d+$/.test(n))
        .map(Number);
    } catch {
      return [];
    }
  },
  stat(pid) {
    try {
      const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // "pid (comm) S ppid ...": comm may contain spaces and parentheses, so cut at the last ')'
      const open = text.indexOf('(');
      const close = text.lastIndexOf(')');
      if (open < 0 || close < open) return undefined;
      const rest = text
        .slice(close + 2)
        .trim()
        .split(' ');
      return { comm: text.slice(open + 1, close), ppid: Number(rest[1]) };
    } catch {
      return undefined;
    }
  },
};

/**
 * What the agent's shell tool runs commands in. Only these direct children of the agent process are "tools": the
 * sandbox's own helpers (socat proxies) and MCP servers are children too and must keep running.
 */
export const TOOL_COMMS = new Set(['bash', 'sh', 'zsh', 'dash', 'bwrap']);

/** Every descendant of `pid`, without `pid` itself. */
export function descendants(pid: number, proc: ProcReader = realProc): number[] {
  const kids = new Map<number, number[]>();
  for (const p of proc.pids()) {
    const st = proc.stat(p);
    if (!st) continue;
    const list = kids.get(st.ppid) ?? [];
    list.push(p);
    kids.set(st.ppid, list);
  }
  const out: number[] = [];
  const queue = [...(kids.get(pid) ?? [])];
  while (queue.length > 0) {
    const p = queue.shift() as number;
    if (out.includes(p)) continue;
    out.push(p);
    queue.push(...(kids.get(p) ?? []));
  }
  return out;
}

/** The tool process trees under the agent process: each direct shell child with everything below it. */
export function toolProcesses(agentPid: number, proc: ProcReader = realProc): number[] {
  const out = new Set<number>();
  for (const p of proc.pids()) {
    const st = proc.stat(p);
    if (!st || st.ppid !== agentPid || !TOOL_COMMS.has(st.comm)) continue;
    out.add(p);
    for (const d of descendants(p, proc)) out.add(d);
  }
  return [...out];
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills the tool processes of the agent process: SIGTERM, then SIGKILL for what is still there after `graceMs`.
 * The agent itself keeps running and sees its command fail. Returns how many processes were signalled.
 */
export async function killToolProcesses(
  agentPid: number | undefined,
  opts: { graceMs?: number; proc?: ProcReader; kill?: typeof signal } = {},
): Promise<number> {
  if (!agentPid || process.platform === 'win32') return 0;
  const proc = opts.proc ?? realProc;
  const kill = opts.kill ?? signal;
  const targets = toolProcesses(agentPid, proc);
  if (targets.length === 0) return 0;
  for (const p of targets) kill(p, 'SIGTERM');
  await new Promise((r) => setTimeout(r, opts.graceMs ?? 3000));
  for (const p of targets) if (proc.stat(p)) kill(p, 'SIGKILL');
  return targets.length;
}
