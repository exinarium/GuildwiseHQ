import { z } from 'zod';

/**
 * MCP servers of this workstation's Claude Code plugins (docs/RUNNER.md "Plugin MCP servers"). The runner reports what
 * is installed and enabled; the project's Owner grants some of them to the project; at a shift or chat start the server
 * sends the granted names only and the runner writes the full configuration locally. Nothing that could be a secret
 * (environment values, headers, tokens, arguments, URLs with query strings) is ever part of these shapes.
 */

/** Claude Code's name for a tool prefix: `mcp__<name>__<tool>`; any character outside this set becomes `_`. */
export const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;
export const MAX_MCP_SERVERS = 100;
export const MAX_GRANTED_MCP_SERVERS = 50;

export const McpTransportSchema = z.enum(['stdio', 'http', 'sse']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

/**
 * One server of an installed, enabled plugin. `name` is the form tools carry in Claude Code (`plugin:atlassian:atlassian`
 * becomes `plugin_atlassian_atlassian`, the tool `mcp__plugin_atlassian_atlassian__search`): the key of a project grant
 * and the `mcp:<name>` permission of a role. `host` is the host name of a remote server (no path, no query).
 */
/**
 * Whether the workstation's user is signed in to a server that needs it (OAuth, kept by Claude Code): `signed_in`,
 * `needs_sign_in`, or `not_needed` (stdio servers). Decided from the presence of a stored sign-in only; older runners
 * omit it.
 */
export const McpAuthStateSchema = z.enum(['signed_in', 'needs_sign_in', 'not_needed']);
export type McpAuthState = z.infer<typeof McpAuthStateSchema>;

/** What the manager is told to do for a server that needs sign-in (shown on the Workstations page and given to agents). */
export const mcpSignInInstruction = (server: string, workstation: string): string =>
  `On ${workstation}, run \`claude\`, then \`/mcp\`, choose ${server}, Authenticate.`;

export const McpServerInfoSchema = z.object({
  name: z.string().min(1).max(120).regex(MCP_NAME_RE),
  plugin: z.string().min(1).max(120),
  server: z.string().min(1).max(120),
  transport: McpTransportSchema,
  host: z.string().max(200).optional(),
  /** Tool names, only when the runner could list them cheaply (it does not start servers to ask). */
  tools: z.array(z.string().max(200)).max(500).optional(),
  authState: McpAuthStateSchema.optional(),
});
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;

/** `plugin:atlassian:atlassian` -> `plugin_atlassian_atlassian` (how Claude Code names the tools of that server). */
export const mcpToolPrefixName = (serverKey: string): string => serverKey.replace(/[^A-Za-z0-9_-]/g, '_');

/** `mcp__plugin_atlassian_atlassian__search` -> { server: 'plugin_atlassian_atlassian', tool: 'search' }. */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice(5);
  const i = rest.indexOf('__');
  if (i <= 0 || i + 2 >= rest.length) return null;
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

const WRITE_WORDS = new Set([
  'create',
  'update',
  'edit',
  'delete',
  'remove',
  'write',
  'send',
  'post',
  'add',
  'transition',
  'move',
  'assign',
  'merge',
  'push',
  'publish',
  'upload',
  'archive',
  'close',
  'reopen',
  'destructive',
  'comment',
  'set',
  'put',
  'patch',
  'drop',
  'destroy',
  'invite',
  'share',
  'approve',
  'deploy',
  'run',
  'rename',
  'link',
  'unlink',
  'cancel',
  'trigger',
  'submit',
  'revoke',
  'grant',
]);

const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Heuristic from tool names (whole words, camelCase and snake_case split): the ones that look like they can write,
 * send or delete. `executeRead` is read-only; a bare `execute...` is treated as able to write.
 */
export function riskyMcpTools(tools: readonly string[]): string[] {
  return tools.filter((t) => {
    const w = words(t);
    return w.some((x) => WRITE_WORDS.has(x)) || (w.includes('execute') && !w.includes('read'));
  });
}

/** Plain-language warning shown next to a server; `tools` unknown: a per-server text. */
export function mcpServerWarning(tools: readonly string[] | undefined): {
  level: 'writes' | 'unknown' | 'read_only';
  text: string;
} {
  if (!tools || tools.length === 0)
    return {
      level: 'unknown',
      text: 'The tools of this server are not known. Assume it can change data, send messages or delete things in the connected service; grant it only to roles that need it and prefer read-only use.',
    };
  const risky = riskyMcpTools(tools);
  if (risky.length > 0)
    return {
      level: 'writes',
      text: `Can write, send or delete (${risky.slice(0, 6).join(', ')}${risky.length > 6 ? ', ...' : ''}). Prefer read-only use.`,
    };
  return { level: 'read_only', text: 'Its tools look read-only (judged from their names).' };
}

/** A server a project's Owner could grant: what the Owner's workstations report. */
export const McpServerCandidateDtoSchema = z.object({
  name: z.string(),
  plugin: z.string(),
  server: z.string(),
  transport: McpTransportSchema,
  host: z.string().nullable(),
  tools: z.array(z.string()).nullable(),
  workstations: z.array(z.string()),
});
export type McpServerCandidateDto = z.infer<typeof McpServerCandidateDtoSchema>;

export const McpServersResponseSchema = z.object({ servers: z.array(McpServerCandidateDtoSchema) });

export const SetProjectMcpServersRequestSchema = z.object({
  servers: z.array(z.string().regex(MCP_NAME_RE).max(120)).max(MAX_GRANTED_MCP_SERVERS),
});
export type SetProjectMcpServersRequest = z.infer<typeof SetProjectMcpServersRequestSchema>;

/** The MCP tools one shift of a card called (shown on the card; names and counts only). */
export const CardMcpUsageSchema = z.object({
  shiftId: z.string(),
  agentName: z.string().nullable(),
  stage: z.string().nullable(),
  startedAt: z.string(),
  calls: z.array(z.object({ server: z.string(), tool: z.string(), count: z.number().int().positive() })),
});
export type CardMcpUsage = z.infer<typeof CardMcpUsageSchema>;

/** MCP tools a shift called, per server and tool. */
export const McpCallSchema = z.object({
  server: z.string(),
  tool: z.string(),
  count: z.number().int().positive(),
});
export type McpCall = z.infer<typeof McpCallSchema>;
