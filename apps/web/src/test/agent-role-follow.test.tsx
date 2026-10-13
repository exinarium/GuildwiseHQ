import { type AgentDto, BUILTIN_ROLES } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentRoleFollow } from '../components/agents/AgentRoleFollow.tsx';

const role = BUILTIN_ROLES.find((r) => r.key === 'builder')!;
const agent = (permissions: AgentDto['permissions']) =>
  ({ roleVersion: role.version, isDevops: false, permissions }) as AgentDto;

describe('AgentRoleFollow', () => {
  it('shows the role version and no changes for an agent on the role baseline', () => {
    render(<AgentRoleFollow agent={agent(role.permissions)} role={role} />);
    expect(screen.getByTestId('agent-role-follow').textContent).toContain(
      `Follows role Builder v${role.version}`,
    );
    expect(screen.getByTestId('agent-role-follow').textContent).toContain('no changes of its own');
  });

  it('lists the agent own deviations', () => {
    const p = {
      ...role.permissions,
      allowedTools: [...role.permissions.allowedTools, 'mcp:plugin_x'],
      deniedShellPatterns: [...role.permissions.deniedShellPatterns, 'npm publish*'],
    };
    render(<AgentRoleFollow agent={agent(p)} role={role} />);
    expect(screen.getByText('extra tools: mcp:plugin_x')).toBeTruthy();
    expect(screen.getByText('extra blocked commands: npm publish*')).toBeTruthy();
  });
});
