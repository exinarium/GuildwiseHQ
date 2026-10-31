import type { ProjectDetailResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestServicesPanel, validateRows } from '../components/TestServicesPanel.tsx';

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const project = (testServices: { name: string; host: string; port: number }[] = []) =>
  ({ id: PROJECT, key: 'GWP', myRole: 'owner', testServices }) as ProjectDetailResponse['project'];

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('validateRows', () => {
  it('refuses non-loopback hosts and bad ports per field', () => {
    for (const host of ['10.0.0.5', 'db.example.com', '0.0.0.0']) {
      const v = validateRows([{ name: 'a', host, port: '5433' }]);
      expect(v.valid).toBe(false);
      expect(v.errors[0]?.host).toMatch(/only 127\.0\.0\.1/);
    }
    for (const port of ['0', '65536', 'abc', '']) {
      const v = validateRows([{ name: 'a', host: '127.0.0.1', port }]);
      expect(v.valid).toBe(false);
      expect(v.errors[0]?.port).toMatch(/1 to 65535/);
    }
  });

  it('accepts a loopback service', () => {
    expect(validateRows([{ name: 'postgres-test', host: '127.0.0.1', port: '5433' }]).valid).toBe(true);
  });
});

describe('TestServicesPanel', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is empty by default', () => {
    wrap(<TestServicesPanel projectId={PROJECT} project={project()} canChange />);
    expect(screen.getByTestId('test-services-empty')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('adds a service and saves the whole list', async () => {
    const user = userEvent.setup();
    wrap(<TestServicesPanel projectId={PROJECT} project={project()} canChange />);
    await user.click(screen.getByRole('button', { name: 'Add service' }));
    await user.type(screen.getByLabelText('Name of service 1'), 'postgres-test');
    await user.type(screen.getByLabelText('Port of service 1'), '5433');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT}/test-services`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      services: [{ name: 'postgres-test', host: '127.0.0.1', port: 5433 }],
    });
  });

  it('edits an entry in place', async () => {
    const user = userEvent.setup();
    wrap(
      <TestServicesPanel
        projectId={PROJECT}
        project={project([{ name: 'pg', host: '127.0.0.1', port: 5433 }])}
        canChange
      />,
    );
    const port = screen.getByLabelText('Port of service 1');
    await user.clear(port);
    await user.type(port, '5434');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).services[0].port).toBe(5434);
  });

  it('removes an entry and saves an empty list', async () => {
    const user = userEvent.setup();
    wrap(
      <TestServicesPanel
        projectId={PROJECT}
        project={project([{ name: 'pg', host: '127.0.0.1', port: 5433 }])}
        canChange
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove service 1' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ services: [] });
  });

  it('shows a message for a non-loopback host and does not save', async () => {
    const user = userEvent.setup();
    wrap(
      <TestServicesPanel
        projectId={PROJECT}
        project={project([{ name: 'pg', host: '127.0.0.1', port: 5433 }])}
        canChange
      />,
    );
    const host = screen.getByLabelText('Host of service 1');
    await user.clear(host);
    await user.type(host, '10.0.0.5');
    expect((await screen.findAllByTestId('test-service-error'))[0]).toHaveTextContent(/only 127\.0\.0\.1/);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a message for a bad port and does not save', async () => {
    const user = userEvent.setup();
    wrap(
      <TestServicesPanel
        projectId={PROJECT}
        project={project([{ name: 'pg', host: '127.0.0.1', port: 5433 }])}
        canChange
      />,
    );
    const port = screen.getByLabelText('Port of service 1');
    await user.clear(port);
    await user.type(port, '70000');
    expect((await screen.findAllByTestId('test-service-error'))[0]).toHaveTextContent(/1 to 65535/);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is read-only when the person cannot change it', () => {
    wrap(
      <TestServicesPanel
        projectId={PROJECT}
        project={project([{ name: 'pg', host: '127.0.0.1', port: 5433 }])}
        canChange={false}
      />,
    );
    expect(screen.getByLabelText('Port of service 1')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByTestId('test-services-readonly')).toBeInTheDocument();
  });
});
