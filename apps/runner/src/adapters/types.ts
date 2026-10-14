import type { AgentRuntimeSpec, ChatContext, Usage } from '@aom/shared';
import type { Sandbox } from '../sandbox/sandbox.ts';

export interface RuntimeCapabilities {
  runtime: string;
  version: string;
  available: boolean;
  /** 'shell','edit','web','mcp','skills','sandbox_config','resume' */
  capabilities: string[];
  /** Effective OS-sandbox state and why (absent: the runtime has no such concept). */
  sandbox?: 'enforced' | 'unsandboxed' | 'unavailable';
  sandboxReason?: string;
  /** The runtime's login: `expired` makes it unavailable until it works again (absent: the runtime has no login). */
  auth?: 'ok' | 'expired';
}

export interface ShiftStartInput {
  shiftId: string;
  /** Rendered card prompt (section 13.2). */
  prompt: string;
  /** Rendered role + standing orders + PROJECT.md + aom contract. */
  instructionsMarkdown: string;
  /** Worktree path or agent scratch dir. */
  cwd: string;
  sandbox: Pick<Sandbox, 'home' | 'configDir' | 'scratch' | 'tmp' | 'cacheRoot'>;
  agent: AgentRuntimeSpec;
  /** AOM_IPC_URL, AOM_SHIFT_TOKEN, AOM_SHIFT_ID, PATH prefix, plus the sandbox env. */
  env: Record<string, string>;
  /** Read access: vault folder of the card's project. */
  addDirs: string[];
  /**
   * Read-only folders besides the vault: the project's reference repositories (resolved to local clones). Never
   * writable; secret files inside stay unreadable (claude-policy.ts).
   */
  readDirs?: string[];
  /** Directories of the agent toolchains (bin and read dirs) sandboxed commands may read (registry.ts). */
  toolchainReadDirs?: string[];
  /**
   * Plugin MCP servers the project's Owner granted (names). The adapter writes the ones the role may call into the
   * agent's MCP config, with the configuration from this workstation's plugins.
   */
  mcpServers?: string[];
  maxShiftMinutes: number;
  /** Chat only. */
  resumeSessionId?: string;
  /** Raw runtime stream is appended here (logs/shifts/<shiftId>.jsonl). */
  logFile?: string;
}

export type RuntimeEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'session'; runtimeSessionId: string }
  | { kind: 'progress'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'final'; text: string }
  | {
      kind: 'exit';
      code: number | null;
      signal?: string;
      error?: string;
      /** The process never ran (spawn failed: E2BIG, ENOENT, EACCES, ...): not an agent crash. `error` says why. */
      startFailed?: boolean;
      /** The runtime's login does not work (expired / not signed in): the shift is put back, not counted as a crash. */
      authFailed?: boolean;
    };

export interface RuntimeSession {
  events(): AsyncIterable<RuntimeEvent>;
  /** SIGTERM, then SIGKILL after 10 s (tree kill on Windows). Resolves once the process is gone. */
  stop(reason: string): Promise<void>;
  usage(): Usage;
}

export interface ChatStartInput {
  chatId: string;
  /** The user's message (one headless call per message). */
  message: string;
  /** Agent scratch dir, or the card worktree when the chat has a card in context (read only). */
  cwd: string;
  sandbox: Pick<Sandbox, 'home' | 'configDir' | 'scratch' | 'tmp' | 'cacheRoot'>;
  agent: AgentRuntimeSpec;
  /** AOM_IPC_URL, AOM_SHIFT_TOKEN (chat scoped), AOM_SHIFT_ID, PATH prefix, plus the sandbox env. */
  env: Record<string, string>;
  /** Previous runtime session of this conversation. */
  resumeSessionId?: string;
  /** Read-only folders: the project's own clones and its reference repositories on this workstation. */
  readDirs?: string[];
  /** Directories of the agent toolchains sandboxed commands may read. */
  toolchainReadDirs?: string[];
  /** Tools are limited to reading (and the chat-scoped `aom` verbs). */
  readOnly: boolean;
  /** What the server told the agent about this conversation (card, project, M7: the intake). */
  context?: ChatContext;
  /** M7: the BA's intake chat: it may read the ticket with the user's Jira tool (MCP) configured on this workstation. */
  intake?: boolean;
  logFile?: string;
}

export interface RuntimeAdapter {
  readonly id: string;
  /** Probed at start and every 10 min. */
  capabilities(): Promise<RuntimeCapabilities>;
  /** Where this runtime reads its instructions (Claude Code: `<configDir>/CLAUDE.md`). */
  writeInstructions(
    sandbox: Pick<Sandbox, 'home' | 'configDir' | 'scratch' | 'tmp' | 'cacheRoot'>,
    markdown: string,
  ): Promise<void>;
  start(input: ShiftStartInput): Promise<RuntimeSession>;
  /**
   * Chat (docs/ARCHITECTURE.md section 14): one headless call per user message, streaming `delta` events, ending with
   * `session` (to resume next time), `usage`, `final` and `exit`.
   */
  startChat?(input: ChatStartInput): Promise<RuntimeSession>;
}
