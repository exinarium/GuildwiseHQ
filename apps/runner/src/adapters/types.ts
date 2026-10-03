import type { AgentRuntimeSpec, Usage } from '@aom/shared';
import type { Sandbox } from '../sandbox/sandbox.ts';

export interface RuntimeCapabilities {
  runtime: string;
  version: string;
  available: boolean;
  /** 'shell','edit','web','mcp','skills','sandbox_config','resume' */
  capabilities: string[];
}

export interface ShiftStartInput {
  shiftId: string;
  /** Rendered card prompt (section 13.2). */
  prompt: string;
  /** Rendered role + standing orders + PROJECT.md + aom contract. */
  instructionsMarkdown: string;
  /** Worktree path or agent scratch dir. */
  cwd: string;
  sandbox: Pick<Sandbox, 'home' | 'configDir' | 'scratch'>;
  agent: AgentRuntimeSpec;
  /** AOM_IPC_URL, AOM_SHIFT_TOKEN, AOM_SHIFT_ID, PATH prefix, plus the sandbox env. */
  env: Record<string, string>;
  /** Read access: vault folder for the card's domain. */
  addDirs: string[];
  maxShiftMinutes: number;
  /** Chat only. */
  resumeSessionId?: string;
  /** Raw runtime stream is appended here (logs/shifts/<shiftId>.jsonl). */
  logFile?: string;
}

export type RuntimeEvent =
  | { kind: 'session'; runtimeSessionId: string }
  | { kind: 'progress'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'final'; text: string }
  | { kind: 'exit'; code: number | null; signal?: string; error?: string };

export interface RuntimeSession {
  events(): AsyncIterable<RuntimeEvent>;
  /** SIGTERM, then SIGKILL after 10 s (tree kill on Windows). Resolves once the process is gone. */
  stop(reason: string): Promise<void>;
  usage(): Usage;
}

export interface RuntimeAdapter {
  readonly id: string;
  /** Probed at start and every 10 min. */
  capabilities(): Promise<RuntimeCapabilities>;
  /** Where this runtime reads its instructions (Claude Code: `<configDir>/CLAUDE.md`). */
  writeInstructions(
    sandbox: Pick<Sandbox, 'home' | 'configDir' | 'scratch'>,
    markdown: string,
  ): Promise<void>;
  start(input: ShiftStartInput): Promise<RuntimeSession>;
}
