import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DevopsSwitchBlock } from '../pages/Desk.tsx';

// UAT 1.10.0 finding 3: a DevOps request waiting for a workstation switch shows the way to the switch and, for Install,
// the copy-paste command for the computer itself.
const CMD = '/home/guildwise-runner/.local/bin/guildwise-runner devops install on';
const WS = '0192f3a0-0000-7000-8000-000000000007';

function show(data: Record<string, unknown>) {
  render(
    <MemoryRouter>
      <DevopsSwitchBlock data={data} />
    </MemoryRouter>,
  );
}

describe('Desk: a DevOps request waiting for a switch', () => {
  it('links to the switch of that workstation and shows the local command once', () => {
    show({
      devopsSwitch: 'allowInstall',
      switchLabel: 'Install packages and tools',
      workstationName: 'Studio',
      workstationId: WS,
      command: CMD,
    });
    const link = screen.getByTestId('desk-devops-switch-link');
    expect(link.textContent).toBe('Turn on “Install packages and tools” for Studio');
    expect(link.getAttribute('href')).toBe(`/workstations?open=${WS}`);
    expect(screen.getByTestId('desk-devops-switch-command-text').textContent).toBe(CMD);
  });

  it('a command outside the grammar is not shown; Docker has only the link', () => {
    show({
      devopsSwitch: 'allowDocker',
      switchLabel: 'Docker',
      workstationName: 'Studio',
      command: `${CMD}; rm -rf ~`,
    });
    expect(screen.queryByTestId('desk-devops-switch-command')).toBeNull();
    expect(screen.getByTestId('desk-devops-switch-link').textContent).toBe('Turn on “Docker” for Studio');
  });
});
