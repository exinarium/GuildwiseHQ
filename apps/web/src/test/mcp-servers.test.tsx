import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoleBuilder } from '../components/builder/RoleBuilder.tsx';
import { McpServersPanel } from '../components/McpServersPanel.tsx';
import { McpUsagePanel } from '../components/McpUsagePanel.tsx';
import { blankRole } from '../lib/designer.ts';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const atlassian = {
  name: 'plugin_atlassian_atlassian',
  plugin: 'atlassian',
  server: 'atlassian',
  transport: 'http' as const,
  host: 'mcp.atlassian.com',
  tools: null,
  workstations: ['Desk'],
};
const notes = {
  name: 'plugin_notes_local',
  plugin: 'notes',
  server: 'local',
  transport: 'stdio' as const,
  host: null,
  tools: ['getNote', 'searchNotes'],
  workstations: ['Desk'],
};
const mail = {
  name: 'plugin_mail_local',
  plugin: 'mail',
  server: 'local',
  transport: 'stdio' as const,
  host: null,
  tools: ['getMessage', 'sendMessage'],
  workstations: ['Desk', 'Laptop'],
};

const calls: Array<{ method: string; url: string; body?: unknown }> = [];
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

const wrap = (el: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('project settings: MCP servers', () => {
  it('the Owner grants a server from what the workstations report and saves the whole list', async () => {
    const user = userEvent.setup();
    wrap(
      <McpServersPanel
        projectId={ID(2)}
        granted={[notes.name]}
        candidates={[atlassian, notes, mail]}
        canGrant
      />,
    );
    expect(screen.getByTestId('mcp-advice')).toHaveTextContent(/prefer read-only/i);
    // granted servers are not offered again
    const select = screen.getByLabelText('Grant an MCP server');
    expect(within(select).queryByText(/notes \/ local/)).toBeNull();
    expect(within(select).getByText(/atlassian \/ atlassian \(remote; on Desk\)/)).toBeInTheDocument();
    expect(
      within(select).getByText(/mail \/ local \(runs on the workstation; on Desk, Laptop\)/),
    ).toBeInTheDocument();
    await user.selectOptions(select, atlassian.name);
    await user.click(screen.getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: expect.stringContaining(`/projects/${ID(2)}/mcp-servers`),
      body: { servers: [notes.name, atlassian.name] },
    });
  });

  it('marks servers that can write, servers with unknown tools and read-only looking ones', () => {
    wrap(
      <McpServersPanel
        projectId={ID(2)}
        granted={[atlassian.name, notes.name, mail.name]}
        candidates={[atlassian, notes, mail]}
        canGrant
      />,
    );
    // tools unknown: a general warning for the server
    expect(screen.getByTestId(`mcp-warning-${atlassian.name}`)).toHaveTextContent(
      /tools of this server are not known/i,
    );
    expect(
      within(screen.getByTestId(`mcp-server-${atlassian.name}`)).getByText('Tools unknown'),
    ).toBeInTheDocument();
    // tool names tell: read-only looking
    expect(
      within(screen.getByTestId(`mcp-server-${notes.name}`)).getByText('Looks read-only'),
    ).toBeInTheDocument();
    // tool names tell: can send
    expect(within(screen.getByTestId(`mcp-server-${mail.name}`)).getByText('Can write')).toBeInTheDocument();
    expect(screen.getByTestId(`mcp-warning-${mail.name}`)).toHaveTextContent('sendMessage');
  });

  it('the Owner removes a server', async () => {
    const user = userEvent.setup();
    wrap(
      <McpServersPanel
        projectId={ID(2)}
        granted={[notes.name, mail.name]}
        candidates={[notes, mail]}
        canGrant
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove notes / local' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ servers: [mail.name] });
  });

  it('others only read: no picker, no remove, still the warnings', () => {
    wrap(<McpServersPanel projectId={ID(2)} granted={[mail.name]} candidates={[]} canGrant={false} />);
    expect(screen.getByTestId(`mcp-server-${mail.name}`)).toHaveTextContent('mcp:plugin_mail_local');
    expect(screen.getByTestId(`mcp-warning-${mail.name}`)).toBeInTheDocument();
    expect(screen.queryByLabelText('Grant an MCP server')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.getByTestId('mcp-owner-only')).toBeInTheDocument();
  });

  it('says so when nothing is granted or nothing is found', () => {
    wrap(<McpServersPanel projectId={ID(2)} granted={[]} candidates={[]} canGrant />);
    expect(screen.getByTestId('mcp-servers-empty')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-servers-none-left')).toHaveTextContent(
      /install and enable a Claude Code plugin/i,
    );
  });
});

describe('card: MCP tools used', () => {
  it('lists the servers and tools per shift, nothing when none were used', () => {
    const { rerender } = render(<McpUsagePanel usage={[]} />);
    expect(screen.queryByTestId('mcp-usage')).toBeNull();
    rerender(
      <McpUsagePanel
        usage={[
          {
            shiftId: ID(9),
            agentName: 'Mina',
            stage: 'build',
            startedAt: '2026-10-13T10:00:00.000Z',
            calls: [
              { server: 'plugin_atlassian_atlassian', tool: 'getJiraIssue', count: 1 },
              { server: 'plugin_atlassian_atlassian', tool: 'searchJiraIssuesUsingJql', count: 2 },
            ],
          },
        ]}
      />,
    );
    const panel = screen.getByTestId('mcp-usage');
    expect(panel).toHaveTextContent('Mina (build)');
    expect(panel).toHaveTextContent('plugin_atlassian_atlassian / searchJiraIssuesUsingJql x2');
    expect(panel).toHaveTextContent('plugin_atlassian_atlassian / getJiraIssue x1');
  });
});

describe('role builder: external tools pick from the known servers', () => {
  it('offers the reported servers as switches and keeps free text for others', async () => {
    const user = userEvent.setup();
    const values: ReturnType<typeof blankRole>[] = [];
    function Harness() {
      const [v, setV] = React.useState({
        ...blankRole(),
        permissions: { ...blankRole().permissions, allowedTools: ['read', 'mcp:custom'] },
      });
      return (
        <RoleBuilder
          value={v}
          onChange={(n) => {
            values.push(n);
            setV(n);
          }}
          departments={[]}
          workflows={[]}
          isOwner
          knownMcpServers={[atlassian, notes]}
        />
      );
    }
    wrap(<Harness />);
    const picker = screen.getByTestId('mcp-picker');
    expect(within(picker).getByRole('checkbox', { name: /atlassian \/ atlassian/ })).not.toBeChecked();
    await user.click(within(picker).getByRole('checkbox', { name: /atlassian \/ atlassian/ }));
    expect(values.at(-1)?.permissions.allowedTools).toEqual([
      'read',
      'mcp:custom',
      'mcp:plugin_atlassian_atlassian',
    ]);
    expect(within(picker).getByRole('checkbox', { name: /atlassian \/ atlassian/ })).toBeChecked();
    await user.click(within(picker).getByRole('checkbox', { name: /atlassian \/ atlassian/ }));
    expect(values.at(-1)?.permissions.allowedTools).toEqual(['read', 'mcp:custom']);
    expect(picker).toHaveTextContent(/only use a server the project's Owner also granted/i);
  });

  it('shows no picker when no server is known', () => {
    wrap(<RoleBuilder value={blankRole()} onChange={() => {}} departments={[]} workflows={[]} isOwner />);
    expect(screen.queryByTestId('mcp-picker')).toBeNull();
    expect(screen.getByLabelText(/External tools/)).toBeInTheDocument();
  });
});
