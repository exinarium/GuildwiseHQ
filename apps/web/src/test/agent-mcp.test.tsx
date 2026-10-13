import type { AgentDto, McpServerCandidateDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMcpSection } from '../components/agents/AgentMcpSection.tsx';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const atlassian: McpServerCandidateDto = {
  name: 'plugin_atlassian_atlassian',
  plugin: 'atlassian',
  server: 'atlassian',
  transport: 'http',
  host: 'mcp.atlassian.com',
  tools: null,
  workstations: ['Desk'],
};
const notes: McpServerCandidateDto = {
  name: 'plugin_notes_local',
  plugin: 'notes',
  server: 'local',
  transport: 'stdio',
  host: null,
  tools: ['getNote'],
  workstations: ['Desk'],
};
const AGENT_ID = '0192f3a0-0000-7000-8000-000000000001';
const agent = (tools: string[]) =>
  ({
    id: AGENT_ID,
    name: 'Bea',
    permissions: {
      allowedTools: tools,
      deniedShellPatterns: [],
      writableGlobs: null,
      mayCommit: false,
      browser: false,
      riskTiers: ['small', 'large'],
      readOrgRepos: false,
      repoIds: null,
    },
  }) as unknown as AgentDto;

const calls: Array<{ method: string; url: string; body?: any }> = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const tree = (el: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{el}</MemoryRouter>
  </QueryClientProvider>
);
const wrap = (el: React.ReactElement) => render(tree(el));

describe('agent external tools (MCP)', () => {
  it('lists the servers with plain-language warnings and the project-grant note', () => {
    wrap(
      <AgentMcpSection
        agent={agent(['read'])}
        candidates={[atlassian, notes]}
        canEdit
        projectSettingsTo="/projects/p1/settings#mcp-servers"
      />,
    );
    expect(screen.getByText('External tools (MCP)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'project settings' })).toHaveAttribute(
      'href',
      '/projects/p1/settings#mcp-servers',
    );
    expect(screen.getByTestId(`agent-mcp-warning-${atlassian.name}`)).toHaveTextContent(/not known/i);
    expect(screen.getByTestId(`agent-mcp-warning-${notes.name}`)).toHaveTextContent(/look read-only/i);
    expect(screen.getByTestId('agent-mcp-advice')).toHaveTextContent(/prefer read-only/i);
    expect(screen.getByRole('switch', { name: /atlassian \/ atlassian/ })).not.toBeChecked();
  });

  it('the Owner switches a server on and off, sending the whole permissions', async () => {
    const user = userEvent.setup();
    const { rerender } = wrap(<AgentMcpSection agent={agent(['read'])} candidates={[notes]} canEdit />);
    await user.click(screen.getByRole('switch', { name: /notes \/ local/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const on = calls.find((c) => c.method === 'PATCH');
    expect(on?.url).toContain(`/agents/${AGENT_ID}`);
    expect(on?.body.permissions.allowedTools).toEqual(['read', 'mcp:plugin_notes_local']);
    expect(on?.body.permissions.mayCommit).toBe(false);

    calls.length = 0;
    rerender(
      tree(
        <AgentMcpSection agent={agent(['read', 'mcp:plugin_notes_local'])} candidates={[notes]} canEdit />,
      ),
    );
    const sw = screen.getByRole('switch', { name: /notes \/ local/ });
    expect(sw).toBeChecked();
    await user.click(sw);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body.permissions.allowedTools).toEqual(['read']);
  });

  it('others only read: switches are disabled, a server the agent has is shown even when unreported', () => {
    wrap(<AgentMcpSection agent={agent(['read', 'mcp:plugin_gone_x'])} candidates={[]} canEdit={false} />);
    const li = screen.getByTestId('agent-mcp-plugin_gone_x');
    expect(within(li).getByRole('switch')).toBeDisabled();
    expect(within(li).getByRole('switch')).toBeChecked();
    expect(screen.getByTestId('agent-mcp-owner-only')).toBeInTheDocument();
  });

  it('shows nothing to a reader when there is nothing to show', () => {
    wrap(<AgentMcpSection agent={agent(['read'])} candidates={[]} canEdit={false} />);
    expect(screen.queryByTestId('agent-mcp')).toBeNull();
  });
});
