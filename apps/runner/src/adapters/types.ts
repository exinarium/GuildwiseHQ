import type { AgentRuntimeSpec, ChatContext, ClaudeAccountInfo, Usage } from '@aom/shared';
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
  /** The subscription's usage limit: `limited` makes the runtime unavailable until `limitedUntil` (ISO) passes and a probe works. */
  usage?: 'ok' | 'limited';
  limitedUntil?: string;
  /** `limitedUntil` as the owner of this machine reads it ("18:00 (Africa/Johannesburg)"). */
  limitedLabel?: string;
  /** Claude Code: every account of this workstation (main first) with its own login and usage state. */
  accounts?: ClaudeAccountInfo[];
}

/** May a shift run on this account now? (`ClaudeCodeAdapter.accountGate`) */
export type AccountGate =
  | { state: 'ok' }
  | { state: 'missing' }
  | { state: 'limited'; limitedUntil?: string; label?: string }
  | { state: 'login'; login: 'expired' | 'none' };

export interface DevopsGuardInput {
  /** Shift or chat id: names the session in the audit trail. */
  sessionRef: string;
  /** Branches (besides main/master) that may never be force-pushed: the project's working branches. */
  protectedBranches?: string[];
  /** Commands the manager approved for this shift: allowed although they leave the workstation. */
  approvedCommands?: string[];
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
  /**
   * Hosts the shell may reach besides the package registries for this shift only: the deployed target a tester tests
   * (docs/design/run-and-integration-tests.md D7). Hostnames, no ports (the sandbox cannot filter ports).
   */
  extraAllowedDomains?: string[];
  maxShiftMinutes: number;
  /** Continue this session (`claude --resume`): a chat's earlier turns, or a card shift that resumes its agent's session. */
  resumeSessionId?: string;
  /** The kind of shift (card shifts get the longer shell timeout for `aom question --wait`). */
  kind?: 'card' | 'question' | 'devops' | 'ba_task' | 'ceo';
  /** Short shifts (question, CEO, DevOps, QA steps) set the prompt cache to 5 minutes: a 1-hour write costs 2x. */
  promptCacheTtl?: '5m';
  /** The DevOps guard hook's inputs (a DevOps shift or chat only; see devops/guard.ts). */
  devopsGuard?: DevopsGuardInput;
  /** The Claude account this shift runs on (absent: `main`). Its config dir is `sandbox.configDir`, one per account per agent. */
  account?: string;
  /** Raw runtime stream is appended here (logs/shifts/<shiftId>.jsonl). */
  logFile?: string;
}

export type RuntimeEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'session'; runtimeSessionId: string }
  | { kind: 'progress'; text: string }
  /** `id`: the runtime's id of the call, to match its result (absent: the runtime does not give one). */
  | { kind: 'tool'; name: string; summary: string; id?: string }
  /** The result of a tool call: how many bytes of text it returned (counted, never kept). */
  | { kind: 'toolresult'; id: string; bytes: number }
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
      /** The subscription's usage limit was hit; it resets at `until` (ISO). The shift is put back, not counted as a crash. */
      usageLimit?: { until: string };
    };

export interface RuntimeSession {
  events(): AsyncIterable<RuntimeEvent>;
  /** SIGTERM, then SIGKILL after 10 s (tree kill on Windows). Resolves once the process is gone. */
  stop(reason: string): Promise<void>;
  usage(): Usage;
  /** The size of the session's context right now (last call's input + cache read + cache write); absent: not measured. */
  contextTokens?(): number;
  /** Kills the commands the agent is running (its tool process trees) and lets the agent go on. Returns how many processes. */
  killTools?(): Promise<number>;
  /** When the runtime last wrote anything (epoch ms); the idle watchdog reads it. */
  lastActivityAt?(): number;
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
  /** The DevOps engineer's chat: the guard hook's inputs (no approved commands: off-workstation work goes through a request). */
  devopsGuard?: DevopsGuardInput;
  /** What the server told the agent about this conversation (card, project, M7: the intake). */
  context?: ChatContext;
  /** M7: the BA's intake chat: it may read the ticket with the user's Jira tool (MCP) configured on this workstation. */
  intake?: boolean;
  /** The Claude account of this chat (absent: `main`; chats always use main today). */
  account?: string;
  logFile?: string;
}

/**
 * A CEO owner or order turn in the full-power profile (docs/design/ceo-front-door.md section 3.3): the Owner's own Claude
 * Code on his workstation, with his `~/.claude`, his home directory and no Guildwise sandbox.
 */
export interface OwnerTurnInput {
  chatId: string;
  mode: 'owner' | 'order';
  /** The full user message (context block, queue note and the message itself). */
  message: string;
  /** The conversation's fixed working directory (`--resume` keys sessions by it). */
  cwd: string;
  agent: AgentRuntimeSpec;
  /** AOM_IPC_URL, AOM_IPC_SOCKET, AOM_SHIFT_TOKEN, AOM_SHIFT_ID, AOM_CEO_TURN_DIR, PATH (runner bin first). */
  env: Record<string, string>;
  /** `<runner root>/ceo-turns/<chatId>`: holds ceo-brief.md, aom-permission.json, floor.json, guard.json. */
  turnDir: string;
  resumeSessionId?: string;
  addDirs?: string[];
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
   * A cheap check that the runtime's login still works, made before a shift starts so the first shift after an expiry
   * is put back (`auth_expired`, no penalty) instead of crashing. Claude Code: reads the login's expiry and only when it
   * is near makes one minimal call (which also refreshes it). Absent: no login to check.
   */
  checkLogin?(account?: string): Promise<'ok' | 'expired' | 'unknown'>;
  /** May a shift run on this account now: known, signed in and not over its usage limit? (Claude Code.) Absent: always. */
  accountGate?(account: string): AccountGate;
  /**
   * Chat (docs/ARCHITECTURE.md section 14): one headless call per user message, streaming `delta` events, ending with
   * `session` (to resume next time), `usage`, `final` and `exit`.
   */
  startChat?(input: ChatStartInput): Promise<RuntimeSession>;
  /** The CEO's full-power turn (never used for a shift): only `ChatManager` calls it, after `selectChatProfile`. */
  startOwnerTurn?(input: OwnerTurnInput): Promise<RuntimeSession>;
}
