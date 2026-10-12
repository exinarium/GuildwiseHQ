import type { DevOpsRequestDto, ProjectRepoDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixWithDevOps } from '../components/devops/FixWithDevOps.tsx';
import { EnvironmentPanel, RepoSetupStatus } from '../components/RepoSetupStatus.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-12T10:00:00.000Z';
const WS = ID(11);
const PROJECT = ID(2);

let requests: DevOpsRequestDto[];
const calls: Array<{ method: string; url: string; body: any }> = [];
const request = (over: Partial<DevOpsRequestDto> = {}): DevOpsRequestDto => ({
  id: ID(50),
  workstationId: WS,
  workstationName: 'Desk',
  devopsAgentId: ID(60),
  devopsAgentName: 'Atlas',
  threadId: ID(70),
  requestedBy: { kind: 'user', id: ID(80) },
  cardId: null,
  cardRef: null,
  summary: 'x',
  status: 'queued',
  approval: null,
  resultSummary: null,
  createdAt: at,
  updatedAt: at,
  ...over,
});

beforeEach(() => {
  requests = [];
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'POST' && url === '/api/devops/requests') {
        const body = JSON.parse(String(init.body));
        requests = [request({ summary: body.summary })];
        return new Response(JSON.stringify({ request: requests[0], messages: [], changes: [] }), {
          status: 201,
        });
      }
      if (url.startsWith('/api/devops/requests'))
        return new Response(JSON.stringify({ requests }), { status: 200 });
      return new Response('{}', { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const wrap = (ui: React.ReactNode, qc = client()) =>
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);

const envPanel = (canCheck = true) => (
  <EnvironmentPanel
    projectId={PROJECT}
    canCheck={canCheck}
    environments={[
      {
        workstationId: WS,
        workstationName: 'Desk',
        state: 'needs_access',
        summary: 'Needs access',
        updatedAt: at,
        report: {
          state: 'needs_access',
          stacks: [],
          tools: [
            {
              stack: 'dotnet-maui',
              tool: '.NET SDK',
              status: 'needs_access',
              detail: 'not found',
              fix: 'Allow "Install packages and tools"',
            },
            { stack: 'node', tool: 'Node.js', status: 'ok', version: '22.1.0' },
            { stack: 'docker', tool: 'Docker', status: 'missing', detail: 'docker: command not found' },
          ],
          summary: 'x',
          logTail: [],
        },
      },
    ]}
  />
);

describe('Fix button on the development environment', () => {
  it('is shown for missing and blocked tools only, and files a DevOps request with the error as context', async () => {
    const user = userEvent.setup();
    wrap(envPanel());
    expect(screen.getAllByTestId('fix-with-devops')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /Fix: Docker \(docker\) is missing on Desk/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/devops/requests');
    expect(post?.body).toMatchObject({
      workstationId: WS,
      origin: 'workstation',
      context: { workstationId: WS, projectId: PROJECT, errorText: 'docker: command not found' },
    });
    expect(post?.body.summary).toContain('Docker (docker) is missing on Desk');
    expect(post?.body.summary).toContain('docker: command not found');
    // progress is shown right there
    expect(await screen.findByText('Requested')).toBeInTheDocument();
  });

  it('runs the environment check again when DevOps is done', async () => {
    const qc = client();
    const user = userEvent.setup();
    wrap(envPanel(), qc);
    await user.click(screen.getByRole('button', { name: /Fix: Docker \(docker\) is missing/ }));
    await screen.findByText('Requested');
    requests = [{ ...(requests[0] as DevOpsRequestDto), status: 'done' }];
    await qc.invalidateQueries({ queryKey: ['devops'] });
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === 'POST' && c.url === `/api/projects/${PROJECT}/environment/check`),
      ).toHaveLength(1),
    );
  });

  it('no Fix button for a member who cannot run the check', () => {
    wrap(envPanel(false));
    expect(screen.queryByTestId('fix-with-devops')).toBeNull();
  });
});

describe('Fix progress and re-check', () => {
  it('follows the request from requested to working to done and runs the check once when DevOps is done', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    const qc = client();
    wrap(<FixWithDevOps workstationId={WS} problem="Docker is missing on Desk" onDone={onDone} />, qc);
    await user.click(screen.getByRole('button', { name: /Fix: Docker is missing/ }));
    expect(await screen.findByText('Requested')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Fix/ })).toBeNull(); // no second request while one is open

    requests = [{ ...(requests[0] as DevOpsRequestDto), status: 'running' }];
    await qc.invalidateQueries({ queryKey: ['devops'] });
    expect(await screen.findByText('DevOps is working on it')).toBeInTheDocument();

    requests = [{ ...(requests[0] as DevOpsRequestDto), status: 'needs_approval' }];
    await qc.invalidateQueries({ queryKey: ['devops'] });
    expect(await screen.findByText('Needs your approval on the desk')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();

    requests = [{ ...(requests[0] as DevOpsRequestDto), status: 'done', resultSummary: 'installed docker' }];
    await qc.invalidateQueries({ queryKey: ['devops'] });
    expect(await screen.findByText('Done')).toBeInTheDocument();
    expect(screen.getByText('installed docker')).toBeInTheDocument();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    await qc.invalidateQueries({ queryKey: ['devops'] });
    expect(onDone).toHaveBeenCalledTimes(1);
    // the owner can also check again by hand, or ask for the fix again
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /Fix again/ })).toBeInTheDocument();
  });

  it('a failed request offers Fix again', async () => {
    const user = userEvent.setup();
    const qc = client();
    wrap(<FixWithDevOps workstationId={WS} problem="Docker is missing on Desk" />, qc);
    await user.click(screen.getByRole('button', { name: /Fix: Docker is missing/ }));
    await screen.findByText('Requested');
    requests = [{ ...(requests[0] as DevOpsRequestDto), status: 'failed' }];
    await qc.invalidateQueries({ queryKey: ['devops'] });
    expect(await screen.findByText('DevOps could not fix it')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fix again/ })).toBeInTheDocument();
  });

  it('picks up an open request for the same problem instead of filing a second one', async () => {
    const summary = [
      'Fix this problem on this workstation: Docker is missing on Desk.',
      'Fix it within your granted access (ask for approval otherwise). When you are done, say what you changed.',
    ].join('\n');
    requests = [request({ summary, status: 'running' })];
    wrap(<FixWithDevOps workstationId={WS} problem="Docker is missing on Desk" />);
    expect(await screen.findByText('DevOps is working on it')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Fix/ })).toBeNull();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('Fix button on a repository that failed to clone', () => {
  const repo = (state: 'failed' | 'cloned'): ProjectRepoDto => ({
    id: ID(1),
    projectId: PROJECT,
    name: 'app',
    remoteUrl: 'https://github.com/acme/app.git',
    remoteUrlNormalized: 'github.com/acme/app',
    workingBranch: null,
    removedAt: null,
    setup: [
      {
        workstationId: WS,
        workstationName: 'Desk',
        state,
        detail: state === 'failed' ? 'Permission denied (publickey)' : null,
        localPath: null,
        updatedAt: at,
      },
    ],
  });

  it('files a request naming the repository, workstation, project and the clone error', async () => {
    const user = userEvent.setup();
    wrap(<RepoSetupStatus projectId={PROJECT} repo={repo('failed')} canRetry />);
    await user.click(screen.getByRole('button', { name: /Fix: the repository app/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/devops/requests');
    expect(post?.body).toMatchObject({
      workstationId: WS,
      origin: 'workstation',
      context: {
        workstationId: WS,
        projectId: PROJECT,
        repoId: ID(1),
        errorText: 'Permission denied (publickey)',
      },
    });
    expect(post?.body.summary).toContain('github.com/acme/app.git');
  });

  it('runs the clone again by itself when DevOps is done', async () => {
    const qc = client();
    wrap(<RepoSetupStatus projectId={PROJECT} repo={repo('failed')} canRetry />, qc);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Fix: the repository app/ }));
    await screen.findByText('Requested');
    expect(calls.some((c) => c.url === `/api/projects/${PROJECT}/repos/${ID(1)}/setup`)).toBe(false);
    requests = [{ ...(requests[0] as DevOpsRequestDto), status: 'done' }];
    await qc.invalidateQueries({ queryKey: ['devops'] });
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === 'POST' && c.url === `/api/projects/${PROJECT}/repos/${ID(1)}/setup`),
      ).toHaveLength(1),
    );
  });

  it('no Fix for a repository that cloned, or for a member who cannot retry', () => {
    wrap(<RepoSetupStatus projectId={PROJECT} repo={repo('cloned')} canRetry />);
    expect(screen.queryByTestId('fix-with-devops')).toBeNull();
  });
});
