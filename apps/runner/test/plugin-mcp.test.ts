import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServerInfoSchema } from '@aom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import {
  claudeHome,
  discoverPluginMcpServers,
  expandPluginRoot,
  mcpConfigFor,
  reportOf,
} from '../src/mcp/plugins.ts';
import { startHarness } from './harness.ts';

/**
 * Plugin MCP servers: discovery from fixture Claude Code homes, what is reported (facts only), and what the agent's
 * mcp.json and credentials hold per role and grant.
 */
let tmp: string;
let home: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aom-mcp-'));
  home = join(tmp, '.claude');
  mkdirSync(join(home, 'plugins'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeJson(path: string, v: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(v));
}

/** Installs a plugin into the fixture home; `enabled` undefined: absent from enabledPlugins. */
function plugin(
  id: string,
  files: Record<string, unknown>,
  o: { enabled?: boolean; scope?: string; installed?: boolean } = {},
) {
  const root = join(tmp, 'cache', id.replace('@', '-'));
  for (const [f, v] of Object.entries(files)) writeJson(join(root, f), v);
  mkdirSync(root, { recursive: true });
  const ip = join(home, 'plugins', 'installed_plugins.json');
  const doc = existsSync(ip) ? JSON.parse(readFileSync(ip, 'utf8')) : { version: 2, plugins: {} };
  if (o.installed !== false) doc.plugins[id] = [{ scope: o.scope ?? 'user', installPath: root }];
  writeJson(ip, doc);
  const sp = join(home, 'settings.json');
  const s = existsSync(sp) ? JSON.parse(readFileSync(sp, 'utf8')) : { enabledPlugins: {} };
  if (o.enabled !== undefined) s.enabledPlugins[id] = o.enabled;
  writeJson(sp, s);
  return root;
}

const SECRET_ENV = { API_TOKEN: 'sekret-env-value' };

function fixture() {
  plugin(
    'atlassian@market',
    { '.mcp.json': { mcpServers: { atlassian: { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp' } } } },
    { enabled: true },
  );
  const files = plugin(
    'files@market',
    {
      '.claude-plugin/plugin.json': {
        name: 'files',
        mcpServers: {
          local: {
            command: '${CLAUDE_PLUGIN_ROOT}/bin/serve',
            args: ['--token', 'sekret-arg', '--root', '${CLAUDE_PLUGIN_ROOT}/data'],
            env: SECRET_ENV,
          },
        },
      },
    },
    { enabled: true },
  );
  plugin(
    'remote@market',
    {
      '.claude-plugin/plugin.json': { mcpServers: './servers.json' },
      'servers.json': {
        docs: {
          type: 'sse',
          url: 'https://docs.example.com/sse?key=sekret-query',
          headers: { Authorization: 'Bearer sekret-header' },
        },
      },
    },
    { enabled: true },
  );
  plugin(
    'off@market',
    { '.mcp.json': { mcpServers: { x: { type: 'http', url: 'https://off.example.com' } } } },
    { enabled: false },
  );
  plugin('unlisted@market', { '.mcp.json': { mcpServers: { y: { command: 'y' } } } });
  plugin(
    'project@market',
    { '.mcp.json': { mcpServers: { z: { command: 'z' } } } },
    { enabled: true, scope: 'project' },
  );
  plugin(
    'gone@market',
    { '.mcp.json': { mcpServers: { w: { command: 'w' } } } },
    { enabled: true, installed: false },
  );
  return { files };
}

describe('plugin MCP server discovery', () => {
  it('finds the servers of installed, enabled, user-scope plugins from plugin.json and .mcp.json', () => {
    const { files } = fixture();
    const found = discoverPluginMcpServers(home);
    expect(found.map((s) => [s.name, s.key, s.transport])).toEqual([
      ['plugin_atlassian_atlassian', 'plugin:atlassian:atlassian', 'http'],
      ['plugin_files_local', 'plugin:files:local', 'stdio'],
      ['plugin_remote_docs', 'plugin:remote:docs', 'sse'],
    ]);
    // disabled, not enabled, project scope and not installed plugins offer nothing
    expect(found.some((s) => ['off', 'unlisted', 'project', 'gone'].includes(s.plugin))).toBe(false);
    // ${CLAUDE_PLUGIN_ROOT} is expanded in the local configuration
    const local = found.find((s) => s.name === 'plugin_files_local');
    expect(local?.config.command).toBe(`${files}/bin/serve`);
    expect(local?.config.args).toEqual(['--token', 'sekret-arg', '--root', `${files}/data`]);
  });

  it('copes with a missing or broken home, and a plugin path that leaves the plugin', () => {
    expect(discoverPluginMcpServers(join(tmp, 'nothing'))).toEqual([]);
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), '{broken');
    expect(discoverPluginMcpServers(home)).toEqual([]);
    rmSync(join(home, 'plugins', 'installed_plugins.json'));
    plugin(
      'sneaky@market',
      {
        '.claude-plugin/plugin.json': { mcpServers: '../outside.json' },
        '../outside.json': { a: { command: 'a' } },
      },
      { enabled: true },
    );
    expect(discoverPluginMcpServers(home)).toEqual([]);
  });

  it('expands the plugin root in nested values only', () => {
    expect(expandPluginRoot({ a: ['$CLAUDE_PLUGIN_ROOT/x', '${HOME}/y'], n: 3 }, '/r')).toEqual({
      a: ['/r/x', '${HOME}/y'],
      n: 3,
    });
  });

  it('uses CLAUDE_CONFIG_DIR of the runner environment when set', () => {
    expect(claudeHome({ CLAUDE_CONFIG_DIR: '/x/y' }, '/home/u')).toBe('/x/y');
    expect(claudeHome({}, '/home/u')).toBe('/home/u/.claude');
  });
});

describe('what the runner reports', () => {
  it('names, plugin, transport and host only: no env, args, headers, URL path or query', () => {
    fixture();
    const report = reportOf(discoverPluginMcpServers(home));
    expect(report).toEqual([
      {
        name: 'plugin_atlassian_atlassian',
        plugin: 'atlassian',
        server: 'atlassian',
        transport: 'http',
        host: 'mcp.atlassian.com',
      },
      { name: 'plugin_files_local', plugin: 'files', server: 'local', transport: 'stdio' },
      {
        name: 'plugin_remote_docs',
        plugin: 'remote',
        server: 'docs',
        transport: 'sse',
        host: 'docs.example.com',
      },
    ]);
    const text = JSON.stringify(report);
    for (const secret of [
      'sekret-env-value',
      'sekret-arg',
      'sekret-query',
      'sekret-header',
      '/v2/mcp',
      'bin/serve',
    ])
      expect(text).not.toContain(secret);
    for (const r of report) expect(McpServerInfoSchema.safeParse(r).success).toBe(true);
  });
});

describe('the agent MCP config: grant and role permission are both required', () => {
  it('writes only granted servers the role may call, keyed the way Claude Code keys them', () => {
    fixture();
    const all = discoverPluginMcpServers(home);
    const granted = ['plugin_atlassian_atlassian', 'plugin_files_local'];
    const both = mcpConfigFor(all, granted, ['read', 'mcp:plugin_atlassian_atlassian']);
    expect(Object.keys(both.mcpServers)).toEqual(['plugin:atlassian:atlassian']);
    expect(both.mcpServers['plugin:atlassian:atlassian']).toEqual({
      type: 'http',
      url: 'https://mcp.atlassian.com/v2/mcp',
    });
    // the role has the permission but the project did not grant it, and the other way round
    expect(mcpConfigFor(all, ['plugin_files_local'], ['mcp:plugin_atlassian_atlassian']).used).toEqual([]);
    expect(mcpConfigFor(all, granted, ['read', 'shell']).used).toEqual([]);
    expect(mcpConfigFor(all, undefined, ['mcp:plugin_files_local']).used).toEqual([]);
    // a name that is no installed server is ignored
    expect(mcpConfigFor(all, ['plugin_ghost_x'], ['mcp:plugin_ghost_x']).used).toEqual([]);
  });
});

describe('the agent config dir', () => {
  const adapter = (cfg: object, realHome: string) =>
    new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse(cfg), undefined, {
      home: realHome,
      mcpServers: () => discoverPluginMcpServers(home),
    });
  const CREDS = {
    claudeAiOauth: { accessToken: 'model-access', refreshToken: 'model-refresh' },
    mcpOAuth: {
      'plugin:atlassian:atlassian|abc123': { accessToken: 'atl-access', refreshToken: 'atl-refresh' },
      'plugin:other:thing|ffff': { accessToken: 'other-access' },
    },
  };
  let real: string;
  let agent: string;
  beforeEach(() => {
    real = join(tmp, 'real-home');
    writeJson(join(real, '.claude', '.credentials.json'), CREDS);
    agent = join(tmp, 'agent-config');
    mkdirSync(agent, { recursive: true });
    fixture();
  });
  const mcpJson = () => JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8'));

  it('writes an empty config without a grant, whatever the role may call', () => {
    const a = adapter({}, real);
    expect(a.writeMcpConfig(agent, ['mcp:plugin_atlassian_atlassian'], undefined)).toEqual([]);
    expect(mcpJson()).toEqual({ mcpServers: {} });
    expect(a.writeMcpConfig(agent, ['mcp:plugin_atlassian_atlassian'], [])).toEqual([]);
  });

  it('a built-in role (no mcp tool of its own) gets the server only with both the agent permission and the project grant', () => {
    const a = adapter({}, real);
    const ba = ['read', 'web']; // e.g. a BA as hired: nothing from mcp:
    const server = 'plugin_atlassian_atlassian';
    const keys = () => Object.keys(mcpJson().mcpServers);
    a.writeMcpConfig(agent, ba, [server]);
    expect(keys()).toEqual([]); // grant without the agent permission
    a.writeMcpConfig(agent, [...ba, `mcp:${server}`], undefined);
    expect(keys()).toEqual([]); // agent permission without the grant
    a.writeMcpConfig(agent, [...ba, `mcp:${server}`], [server]);
    expect(keys()).toEqual(['plugin:atlassian:atlassian']); // both
  });

  it('writes the full local configuration (secrets included) readable by the runner user only', () => {
    const a = adapter({}, real);
    const used = a.writeMcpConfig(agent, ['read', 'mcp:plugin_files_local'], ['plugin_files_local']);
    expect(used.map((u) => u.name)).toEqual(['plugin_files_local']);
    const cfg = mcpJson().mcpServers['plugin:files:local'];
    expect(cfg.env).toEqual(SECRET_ENV);
    expect(cfg.args).toContain('sekret-arg');
    if (process.platform !== 'win32') expect(statSync(join(agent, 'mcp.json')).mode & 0o077).toBe(0);
  });

  it('keeps the BA intake config and adds granted servers to it', () => {
    const intake = join(tmp, 'intake.json');
    writeJson(intake, { mcpServers: { jira: { command: 'jira-mcp' } } });
    const a = adapter({}, real);
    a.writeMcpConfig(agent, ['mcp:plugin_files_local'], ['plugin_files_local'], intake);
    expect(Object.keys(mcpJson().mcpServers).sort()).toEqual(['jira', 'plugin:files:local']);
  });

  it('with the default login the agent gets a private copy (never a symlink)', async () => {
    const a = adapter({ authMode: 'default' }, real);
    const used = a.writeMcpConfig(agent, ['mcp:plugin_atlassian_atlassian'], ['plugin_atlassian_atlassian']);
    await a.linkCredentials(agent, used);
    expect(lstatSync(join(agent, '.credentials.json')).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(join(agent, '.credentials.json'), 'utf8'))).toEqual(CREDS);
  });

  it('with a configured token only the OAuth entries of the servers in use are copied', async () => {
    const a = adapter({ authMode: 'oauth', oauthToken: 'tok' }, real);
    const used = a.writeMcpConfig(agent, ['mcp:plugin_atlassian_atlassian'], ['plugin_atlassian_atlassian']);
    await a.linkCredentials(agent, used);
    const copy = JSON.parse(readFileSync(join(agent, '.credentials.json'), 'utf8'));
    expect(copy).toEqual({
      mcpOAuth: { 'plugin:atlassian:atlassian|abc123': CREDS.mcpOAuth['plugin:atlassian:atlassian|abc123'] },
    });
    expect(JSON.stringify(copy)).not.toContain('model-access');
    expect(JSON.stringify(copy)).not.toContain('other-access');
    expect(lstatSync(join(agent, '.credentials.json')).isSymbolicLink()).toBe(false);
    if (process.platform !== 'win32') expect(statSync(join(agent, '.credentials.json')).mode & 0o077).toBe(0);
  });

  it('with a configured token and no server in use no credentials file is left behind', async () => {
    const a = adapter({ authMode: 'api_key', apiKey: 'k' }, real);
    writeFileSync(join(agent, '.credentials.json'), 'stale');
    await a.linkCredentials(agent, []);
    expect(existsSync(join(agent, '.credentials.json'))).toBe(false);
  });
});

describe('the report over the connection', () => {
  it('is sent after welcome with facts only', async () => {
    fixture();
    const h = await startHarness({}, { mcpReport: true, mcpDiscover: () => discoverPluginMcpServers(home) });
    try {
      const report = await h.server.waitFor('mcp.servers', () => true, 15_000);
      expect(report.servers.map((s) => s.name)).toEqual([
        'plugin_atlassian_atlassian',
        'plugin_files_local',
        'plugin_remote_docs',
      ]);
      expect(JSON.stringify(report)).not.toContain('sekret');
    } finally {
      await h.stop();
    }
  });

  it('is not sent under the test runner unless asked for', async () => {
    const h = await startHarness();
    try {
      await h.server.waitFor('org.folders', () => true, 15_000);
      expect(h.server.received.some((m) => m.type === 'mcp.servers')).toBe(false);
    } finally {
      await h.stop();
    }
  });
});
