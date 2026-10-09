import type { ProjectRepoDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EnvironmentPanel, RepoSetupStatus } from '../components/RepoSetupStatus.tsx';

const ID = '0192f3a0-0000-7000-8000-0000000000';
const repo = (setup: ProjectRepoDto['setup']): ProjectRepoDto => ({
  id: `${ID}01`,
  projectId: `${ID}02`,
  name: 'app',
  remoteUrl: 'https://github.com/acme/app.git',
  remoteUrlNormalized: 'github.com/acme/app',
  workingBranch: null,
  removedAt: null,
  setup,
});
const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
const at = '2026-10-10T10:00:00.000Z';

describe('repository setup status', () => {
  it('shows Cloning, Cloned on <workstation> and Failed: reason, with a retry only when something failed', () => {
    wrap(
      <RepoSetupStatus
        projectId={`${ID}02`}
        canRetry
        repo={repo([
          {
            workstationId: `${ID}11`,
            workstationName: 'Desk',
            state: 'cloning',
            detail: null,
            localPath: null,
            updatedAt: at,
          },
          {
            workstationId: `${ID}12`,
            workstationName: 'Laptop',
            state: 'cloned',
            detail: 'Cloned to /x',
            localPath: '/x',
            updatedAt: at,
          },
          {
            workstationId: `${ID}13`,
            workstationName: 'Mini',
            state: 'failed',
            detail: 'no access',
            localPath: null,
            updatedAt: at,
          },
        ])}
      />,
    );
    const list = screen.getByTestId('repo-setup-app');
    expect(list).toHaveTextContent('Cloning');
    expect(list).toHaveTextContent('Cloned');
    expect(list).toHaveTextContent('on Laptop');
    expect(list).toHaveTextContent('Failed: no access');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('no retry for a member who is not the owner, and nothing when there is no setup', () => {
    const { container } = wrap(
      <RepoSetupStatus
        projectId={`${ID}02`}
        canRetry={false}
        repo={repo([
          {
            workstationId: `${ID}13`,
            workstationName: 'Mini',
            state: 'failed',
            detail: 'x',
            localPath: null,
            updatedAt: at,
          },
        ])}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    container.innerHTML = '';
    const empty = wrap(<RepoSetupStatus projectId={`${ID}02`} canRetry repo={repo([])} />);
    expect(empty.container.querySelector('[data-testid]')).toBeNull();
  });
});

describe('environment panel', () => {
  it('lists each workstation with its tools, what is missing and how to fix it', () => {
    wrap(
      <EnvironmentPanel
        projectId={`${ID}02`}
        canCheck
        environments={[
          {
            workstationId: `${ID}11`,
            workstationName: 'Desk',
            state: 'needs_access',
            summary: 'Needs access: .NET SDK (not found)',
            updatedAt: at,
            report: {
              state: 'needs_access',
              stacks: [],
              tools: [
                {
                  stack: 'dotnet-maui',
                  tool: '.NET SDK',
                  status: 'needs_access',
                  fix: 'Allow "Install packages and tools"',
                },
                { stack: 'node', tool: 'Node.js', status: 'ok', version: '22.1.0' },
              ],
              summary: 'x',
              logTail: ['$ apt-get install'],
            },
          },
        ]}
      />,
    );
    const env = screen.getByTestId('environments');
    expect(env).toHaveTextContent('Desk');
    expect(env).toHaveTextContent('Needs access');
    expect(env).toHaveTextContent('How to fix: Allow "Install packages and tools"');
    expect(env).toHaveTextContent('Node.js 22.1.0');
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });
});
