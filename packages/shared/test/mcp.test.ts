import { describe, expect, it } from 'vitest';
import {
  McpServerInfoSchema,
  mcpServerWarning,
  mcpToolPrefixName,
  parseMcpToolName,
  riskyMcpTools,
} from '../src/index.ts';

describe('plugin MCP server names', () => {
  it('turns a Claude Code server key into its tool-prefix name and back out of a tool name', () => {
    expect(mcpToolPrefixName('plugin:atlassian:atlassian')).toBe('plugin_atlassian_atlassian');
    expect(mcpToolPrefixName('plugin:my.plugin:a b')).toBe('plugin_my_plugin_a_b');
    expect(parseMcpToolName('mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql')).toEqual({
      server: 'plugin_atlassian_atlassian',
      tool: 'searchJiraIssuesUsingJql',
    });
    expect(parseMcpToolName('Bash')).toBeNull();
    expect(parseMcpToolName('mcp__only')).toBeNull();
    expect(parseMcpToolName('mcp__server__')).toBeNull();
  });

  it('accepts facts and rejects names a permission could not hold', () => {
    const ok = { name: 'plugin_a_b', plugin: 'a', server: 'b', transport: 'stdio' };
    expect(McpServerInfoSchema.safeParse(ok).success).toBe(true);
    expect(McpServerInfoSchema.safeParse({ ...ok, name: 'plugin:a:b' }).success).toBe(false);
    expect(McpServerInfoSchema.safeParse({ ...ok, transport: 'websocket' }).success).toBe(false);
  });
});

describe('the write heuristic', () => {
  it('flags tools whose names read as write, send or delete, by whole words', () => {
    expect(
      riskyMcpTools([
        'getJiraIssue',
        'searchConfluence',
        'createJiraIssue',
        'addOrEditJiraIssueComment',
        'transitionJiraIssue',
        'executeRead',
        'executeWrite',
        'executeDestructive',
        'execute',
        'list_assets',
        'delete_page',
        'send-message',
        'getAssets',
        'discover',
      ]),
    ).toEqual([
      'createJiraIssue',
      'addOrEditJiraIssueComment',
      'transitionJiraIssue',
      'executeWrite',
      'executeDestructive',
      'execute',
      'delete_page',
      'send-message',
    ]);
  });

  it('warns per server: writes, unknown tools, or read-only looking', () => {
    expect(mcpServerWarning(['getIssue', 'createIssue']).level).toBe('writes');
    expect(mcpServerWarning(['getIssue', 'search']).level).toBe('read_only');
    const unknown = mcpServerWarning(undefined);
    expect(unknown.level).toBe('unknown');
    expect(unknown.text).toMatch(/not known/);
    expect(mcpServerWarning([]).level).toBe('unknown');
  });
});
