import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { type McpServerInfo, type McpTransport, mcpToolPrefixName } from '@aom/shared';

/**
 * MCP servers that come from Claude Code plugins, found the way Claude Code finds them: the plugin is installed
 * (`<claude home>/plugins/installed_plugins.json`), enabled (`enabledPlugins` of `<claude home>/settings.json`), and
 * declares servers in `plugin.json` (`mcpServers`: an inline object, a path, or a list of those) and/or a `.mcp.json`
 * at the plugin root. Claude Code names such a server `plugin:<plugin>:<server>` and its tools
 * `mcp__plugin_<plugin>_<server>__<tool>`; that last form is the name used everywhere in Guildwise.
 *
 * Only user-scope installs count (a project- or local-scope plugin belongs to one repository's settings, not to the
 * workstation). Nothing is executed here: files are read, never run.
 */

export interface PluginMcpServer {
  /** `plugin_atlassian_atlassian`: the tool-prefix name, the key of grants and `mcp:<name>` permissions. */
  name: string;
  /** `plugin:atlassian:atlassian`: the key Claude Code uses in the mcp config (and for OAuth tokens). */
  key: string;
  plugin: string;
  server: string;
  transport: McpTransport;
  /** The plugin root (absolute) the server was found in. */
  root: string;
  /** The server entry as the plugin declares it, `${CLAUDE_PLUGIN_ROOT}` expanded. LOCAL ONLY: may hold secrets. */
  config: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Where Claude Code keeps its user state on this machine (`CLAUDE_CONFIG_DIR` of the runner's own environment wins). */
export function claudeHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, '.claude');
}

/** `${CLAUDE_PLUGIN_ROOT}` (and the `$CLAUDE_PLUGIN_ROOT` form) inside every string of a server entry. Other variables stay. */
export function expandPluginRoot<T>(value: T, root: string): T {
  if (typeof value === 'string')
    return value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, root) as T;
  if (Array.isArray(value)) return value.map((v) => expandPluginRoot(v, root)) as T;
  if (isObj(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandPluginRoot(v, root)])) as T;
  return value;
}

function transportOf(entry: Record<string, unknown>): McpTransport | undefined {
  const t = typeof entry.type === 'string' ? entry.type.toLowerCase() : undefined;
  if (t === 'sse') return 'sse';
  if (t === 'http' || t === 'streamable-http' || t === 'streamable_http') return 'http';
  if (t === 'stdio') return 'stdio';
  if (typeof entry.command === 'string') return 'stdio';
  if (typeof entry.url === 'string') return 'http';
  return undefined;
}

/** A `.mcp.json` is either `{ "mcpServers": { ... } }` or the bare map of servers. */
function serversOf(doc: unknown): Record<string, Record<string, unknown>> {
  if (!isObj(doc)) return {};
  const map = isObj(doc.mcpServers) ? doc.mcpServers : doc;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(map)) if (isObj(entry) && transportOf(entry)) out[name] = entry;
  return out;
}

function declaredServers(root: string): Record<string, Record<string, unknown>> {
  const found: Record<string, Record<string, unknown>> = {};
  const manifest =
    readJson(join(root, '.claude-plugin', 'plugin.json')) ?? readJson(join(root, 'plugin.json'));
  const decl = isObj(manifest) ? manifest.mcpServers : undefined;
  const parts = Array.isArray(decl) ? decl : decl === undefined ? [] : [decl];
  for (const part of parts) {
    if (typeof part === 'string') {
      // a path inside the plugin, never outside it
      const p = isAbsolute(part) ? part : resolve(root, part);
      if (p.startsWith(root + sep)) Object.assign(found, serversOf(readJson(p)));
    } else Object.assign(found, serversOf(part));
  }
  // the default file of a plugin; a server declared in plugin.json keeps its manifest entry
  for (const [k, v] of Object.entries(serversOf(readJson(join(root, '.mcp.json')))))
    if (!(k in found)) found[k] = v;
  return found;
}

interface InstallRecord {
  scope?: string;
  installPath?: string;
}

function installsOf(doc: unknown): Array<{ id: string; installPath: string }> {
  if (!isObj(doc) || !isObj(doc.plugins)) return [];
  const out: Array<{ id: string; installPath: string }> = [];
  for (const [id, v] of Object.entries(doc.plugins)) {
    const list: InstallRecord[] = Array.isArray(v)
      ? (v as InstallRecord[])
      : isObj(v)
        ? [v as InstallRecord]
        : [];
    // user scope only; a version-1 record has no scope and is a user install
    const rec = list.find(
      (r) => isObj(r) && typeof r.installPath === 'string' && (r.scope ?? 'user') === 'user',
    );
    if (rec?.installPath) out.push({ id, installPath: rec.installPath });
  }
  return out;
}

/** The enabled, installed plugins' MCP servers, stable order (by name). Never throws. */
export function discoverPluginMcpServers(home: string = claudeHome()): PluginMcpServer[] {
  const installed = readJson(join(home, 'plugins', 'installed_plugins.json'));
  const settings = readJson(join(home, 'settings.json'));
  const enabled = isObj(settings) && isObj(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const out: PluginMcpServer[] = [];
  const seen = new Set<string>();
  for (const { id, installPath } of installsOf(installed)) {
    if (enabled[id] !== true) continue;
    const root = resolve(installPath);
    if (!existsSync(root)) continue;
    const plugin = id.split('@')[0] as string;
    for (const [server, raw] of Object.entries(declaredServers(root))) {
      const key = `plugin:${plugin}:${server}`;
      const name = mcpToolPrefixName(key);
      const transport = transportOf(raw);
      if (!transport || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, key, plugin, server, transport, root, config: expandPluginRoot(raw, root) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Host name of a remote server, nothing else of the URL (a path or query may carry a token). */
function hostOf(config: Record<string, unknown>): string | undefined {
  if (typeof config.url !== 'string') return undefined;
  try {
    return new URL(config.url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** What goes to the server: facts only. No env, headers, args, command, URL or token. */
export function reportOf(servers: PluginMcpServer[]): McpServerInfo[] {
  return servers.map((s) => {
    const host = s.transport === 'stdio' ? undefined : hostOf(s.config);
    return {
      name: s.name,
      plugin: s.plugin,
      server: s.server,
      transport: s.transport,
      ...(host ? { host } : {}),
    };
  });
}

/**
 * The `mcpServers` block of an agent's mcp.json: the granted servers this role may call (`mcp:<name>` in its
 * permissions) that exist on this workstation. Keyed by Claude Code's own `plugin:<plugin>:<server>` so the tool names
 * and the stored OAuth token (keyed by that name plus a hash of the connection) are the ones the user already has.
 */
export function mcpConfigFor(
  servers: PluginMcpServer[],
  granted: readonly string[] | undefined,
  allowedTools: readonly string[],
): { mcpServers: Record<string, Record<string, unknown>>; used: PluginMcpServer[] } {
  const allowed = new Set(allowedTools.filter((t) => t.startsWith('mcp:')).map((t) => t.slice(4)));
  const used = servers.filter((s) => granted?.includes(s.name) && allowed.has(s.name));
  return { mcpServers: Object.fromEntries(used.map((s) => [s.key, s.config])), used };
}
