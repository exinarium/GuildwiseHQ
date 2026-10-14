import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationTestsSettings } from '../components/runs/IntegrationTestsSettings.tsx';
import { IntegrationTestsToggle, SuiteResultsPanel } from '../components/runs/SuiteResults.tsx';
import { TargetTesting } from '../components/runs/TargetTesting.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { fromDefinition, toDefinition } from '../lib/builder.ts';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PROJECT = ID(1);
const WEB = ID(10);

const response = (over: Record<string, unknown> = {}) => ({
  settings: { mode: 'off', services: [], suites: [], keepOnFailureMin: 60, flakyRetry: 1 },
  repos: [{ repoId: WEB, name: 'web' }],
  targets: [],
  canProvision: true,
  ...over,
});

const calls: Array<{ method: string; url: string; body?: any }> = [];
let routes: Record<string, (init: RequestInit) => Response> = {};
beforeEach(() => {
  calls.length = 0;
  routes = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return routes[`${init.method ?? 'GET'} ${String(url).split('?')[0]}`]?.(init) ?? json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{el}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};
const URL_ = `/api/projects/${PROJECT}/integration-tests`;

describe('integration test settings', () => {
  it('starts off, switches on, takes a suite and saves it', async () => {
    routes[`GET ${URL_}`] = () => json(response());
    routes[`PUT ${URL_}`] = (init) => json(response({ settings: JSON.parse(String(init.body)).settings }));
    const user = userEvent.setup();
    wrap(<IntegrationTestsSettings projectId={PROJECT} canEdit />);
    const mode = await screen.findByTestId('integration-mode');
    expect(mode).toHaveValue('off');
    expect(screen.queryByTestId('add-suite')).toBeNull();

    await user.selectOptions(mode, 'local');
    await user.click(screen.getByTestId('add-suite'));
    const name = screen.getAllByLabelText('Name')[0] as HTMLInputElement;
    await user.type(name, 'api');
    await user.type(screen.getByLabelText('Command'), 'npm run it');
    await user.clear(screen.getByTestId('integration-keep'));
    await user.type(screen.getByTestId('integration-keep'), '30');
    await user.click(screen.getByTestId('integration-save'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    const body = calls.find((c) => c.method === 'PUT')!.body;
    expect(body.settings).toMatchObject({ mode: 'local', keepOnFailureMin: 30, flakyRetry: 1 });
    expect(body.settings.suites).toEqual([
      {
        name: 'api',
        repoId: WEB,
        cwd: '.',
        cmd: ['npm', 'run', 'it'],
        kind: 'integration',
        timeoutMin: 20,
        destructive: false,
        confirmed: true,
      },
    ]);
  });

  it('shows a suite a tester proposed and confirms it', async () => {
    const proposed = {
      name: 'smoke',
      repoId: WEB,
      cwd: '.',
      cmd: ['npx', 'playwright', 'test'],
      kind: 'e2e',
      timeoutMin: 20,
      destructive: false,
      confirmed: false,
    };
    routes[`GET ${URL_}`] = () =>
      json(
        response({
          settings: { mode: 'local', services: [], suites: [proposed], keepOnFailureMin: 60, flakyRetry: 1 },
        }),
      );
    routes[`POST ${URL_}/suites/smoke/confirm`] = () =>
      json(
        response({
          settings: {
            mode: 'local',
            services: [],
            suites: [{ ...proposed, confirmed: true }],
            keepOnFailureMin: 60,
            flakyRetry: 1,
          },
        }),
      );
    const user = userEvent.setup();
    wrap(<IntegrationTestsSettings projectId={PROJECT} canEdit />);
    const row = await screen.findByTestId('suite-row-smoke');
    expect(row).toHaveTextContent('Proposed by a tester');
    await user.click(screen.getByTestId('confirm-suite-smoke'));
    await waitFor(() => expect(screen.queryByText('Proposed by a tester')).toBeNull());
    expect(calls.find((c) => c.url.endsWith('/suites/smoke/confirm'))?.body).toEqual({ confirmed: true });
  });

  it('warns when no runner can start environments, and refuses a bad suite before saving', async () => {
    routes[`GET ${URL_}`] = () =>
      json(
        response({
          settings: { mode: 'local', services: [], suites: [], keepOnFailureMin: 60, flakyRetry: 1 },
          canProvision: false,
        }),
      );
    const user = userEvent.setup();
    wrap(<IntegrationTestsSettings projectId={PROJECT} canEdit />);
    expect(await screen.findByText(/runner that can start test environments/)).toBeInTheDocument();
    await user.click(screen.getByTestId('add-suite'));
    await user.click(screen.getByTestId('integration-save'));
    expect(await screen.findByTestId('integration-problem')).toHaveTextContent(/needs a name/);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('is read-only for someone who is not the project owner', async () => {
    routes[`GET ${URL_}`] = () => json(response());
    wrap(<IntegrationTestsSettings projectId={PROJECT} canEdit={false} />);
    expect(await screen.findByTestId('integration-mode')).toBeDisabled();
    expect(screen.queryByTestId('integration-save')).toBeNull();
  });
});

describe('suite results on the card', () => {
  const result = (over: Record<string, unknown> = {}) => ({
    id: ID(100),
    suite: 'api',
    kind: 'integration',
    envMode: 'local',
    targetName: null,
    commit: 'abcdef0123456789',
    status: 'passed',
    passed: 12,
    failed: 0,
    skipped: 1,
    durationMs: 4200,
    attempts: 1,
    failures: [],
    attachmentId: ID(200),
    note: null,
    createdAt: new Date().toISOString(),
    ...over,
  });
  const testing = (over: Record<string, unknown> = {}) =>
    ({ suiteResults: [], testEnvironment: null, ...over }) as never;

  it('lists every run with counts, the commit and a log link; a flaky suite is explained', () => {
    wrap(
      <SuiteResultsPanel
        cardId={ID(300)}
        testing={testing({
          suiteResults: [
            result({
              id: ID(101),
              status: 'failed',
              failed: 2,
              failures: ['api.items > creates'],
              passed: 10,
            }),
            result({ id: ID(102), status: 'flaky', attempts: 2 }),
            result({ id: ID(103), suite: 'e2e', kind: 'e2e', status: 'skipped', attachmentId: null }),
          ],
        })}
      />,
    );
    const rows = screen.getAllByTestId('suite-result');
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText('failed')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('10 / 2 / 1');
    expect(rows[0]).toHaveTextContent('api.items > creates');
    expect(rows[0]).toHaveTextContent('this branch, commit abcdef0');
    expect(rows[1]).toHaveTextContent('attempt 2');
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: 'log' })).toHaveAttribute(
      'href',
      `/api/cards/${ID(300)}/attachments/${ID(200)}?download=1`,
    );
    expect(screen.getByTestId('flaky-notice')).toHaveTextContent('api failed first and passed on a re-run');
    expect(within(rows[2] as HTMLElement).queryByRole('link')).toBeNull();
  });

  it('says how long a failed card keeps its environment', () => {
    wrap(
      <SuiteResultsPanel
        cardId={ID(300)}
        testing={testing({
          testEnvironment: {
            envId: ID(50),
            state: 'healthy',
            activity: null,
            workstationName: 'Desk',
            keptUntil: new Date(Date.now() + 3600_000).toISOString(),
            lastError: null,
            commit: 'abcdef0123',
            urls: ['http://localhost:5173/'],
          },
        })}
      />,
    );
    expect(screen.getByTestId('test-environment')).toHaveTextContent('Test environment on Desk');
    expect(screen.getByTestId('env-kept')).toHaveTextContent('Kept for inspection until');
    expect(screen.getByText('http://localhost:5173/')).toBeInTheDocument();
  });

  it('renders nothing for a card with no suites and no environment', () => {
    const { container } = wrap(<SuiteResultsPanel cardId={ID(300)} testing={testing()} />);
    expect(container.querySelector('[data-testid="suite-results"]')).toBeNull();
  });

  it('the card switch patches the card and is read-only when it cannot be changed', async () => {
    routes[`PATCH /api/cards/${ID(300)}`] = () => json({});
    const user = userEvent.setup();
    wrap(<IntegrationTestsToggle cardId={ID(300)} value editable />);
    await user.click(screen.getByRole('checkbox'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ integrationTests: false }),
    );
  });

  it('shows a plain word when it is not editable', () => {
    wrap(<IntegrationTestsToggle cardId={ID(300)} value={false} editable={false} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByTestId('integration-toggle')).toHaveTextContent('skipped');
  });
});

describe('workflow builder', () => {
  it('keeps a step that needs a running environment, both ways', () => {
    const def = {
      key: 'x',
      name: 'X',
      fieldSet: 'custom',
      customFields: [],
      cardTypes: ['feature'],
      initialStage: 'a',
      stages: [
        {
          id: 'a',
          label: 'A',
          column: 'A',
          kind: 'agent',
          claimRole: 'tester',
          environment: 'project',
          doneCriteria: 'd',
          outcomes: [],
        },
        {
          id: 'b',
          label: 'B',
          column: 'B',
          kind: 'terminal',
          claimRole: null,
          doneCriteria: '',
          outcomes: [],
        },
      ],
    };
    const model = fromDefinition(def as never);
    expect(model.steps[0]?.environment).toBe(true);
    expect(model.steps[1]?.environment).toBe(false);
    const back = toDefinition(model);
    expect(back.stages?.[0]).toMatchObject({ environment: 'project' });
    expect(back.stages?.[1]).not.toHaveProperty('environment');
  });
});

describe('remote mode and deployed targets', () => {
  const target = (over: Record<string, unknown> = {}) => ({
    id: ID(40),
    projectId: PROJECT,
    name: 'staging',
    kind: 'local_docker',
    workstationId: null,
    workstationName: null,
    host: null,
    appUrl: 'https://staging.example.test',
    notes: '',
    createdAt: new Date().toISOString(),
    testEnabled: false,
    production: false,
    destructiveOk: false,
    testHosts: [],
    secretNames: [],
    ...over,
  });
  const ws = (over: Record<string, unknown> = {}) => ({
    id: ID(20),
    name: 'Desk',
    ownerId: ID(2),
    ownerName: 'Pieter',
    mine: true,
    connected: true,
    hasDevops: true,
    ...over,
  });

  it('offers only targets the tester may test, and saves the chosen one', async () => {
    routes[`GET ${URL_}`] = () =>
      json(
        response({
          targets: [
            {
              id: ID(40),
              name: 'staging',
              url: 'https://staging.example.test',
              testEnabled: true,
              production: false,
            },
            {
              id: ID(41),
              name: 'live',
              url: 'https://live.example.test',
              testEnabled: false,
              production: true,
            },
          ],
        }),
      );
    routes[`PUT ${URL_}`] = (init) => json(response({ settings: JSON.parse(String(init.body)).settings }));
    const user = userEvent.setup();
    wrap(<IntegrationTestsSettings projectId={PROJECT} canEdit />);
    await user.selectOptions(await screen.findByTestId('integration-mode'), 'remote');
    const select = screen.getByTestId('integration-target');
    expect(within(select).getByRole('option', { name: /live .*production, never tested/ })).toBeDisabled();
    await user.click(screen.getByTestId('integration-save'));
    expect(await screen.findByTestId('integration-problem')).toHaveTextContent(/needs a deploy target/);
    await user.selectOptions(select, ID(40));
    await user.click(screen.getByTestId('integration-save'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PUT')?.body.settings).toMatchObject({
      mode: 'remote',
      deployTargetId: ID(40),
    });
  });

  it('opts a target in with its hosts and test accounts; production is refused before the server hears of it', async () => {
    routes[`PATCH /api/deploy-targets/${ID(40)}`] = () => json(target());
    const user = userEvent.setup();
    wrap(<TargetTesting projectId={PROJECT} target={target() as never} workstations={[ws()]} />);
    await user.click(screen.getByTestId('target-production'));
    await user.click(screen.getByTestId('target-test-enabled'));
    await user.click(screen.getByTestId('target-testing-save'));
    expect(await screen.findByTestId('target-testing-problem')).toHaveTextContent(/never tested/);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await user.click(screen.getByTestId('target-production'));
    await user.click(screen.getByTestId('target-destructive'));
    await user.type(screen.getByLabelText('Extra hosts the tester may reach'), 'api.staging.example.test');
    await user.type(screen.getByLabelText('Test accounts (names)'), 'TEST_USER_PASSWORD');
    await user.click(screen.getByTestId('target-testing-save'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      testEnabled: true,
      production: false,
      destructiveOk: true,
      testHosts: ['api.staging.example.test'],
      secretNames: ['TEST_USER_PASSWORD'],
    });
  });

  it('seals a test account value in the browser and sends only the ciphertext', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['encrypt', 'decrypt'],
    );
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    let bin = '';
    for (const b of spki) bin += String.fromCharCode(b);
    routes[`GET /api/workstations/${ID(20)}/sudo-key`] = () =>
      json({ keyId: 'abcd1234abcd1234', publicKey: btoa(bin) });
    routes[`PUT /api/workstations/${ID(20)}/target-secrets`] = () => json({ queued: true }, 202);
    routes[`GET /api/projects/${PROJECT}/target-secrets`] = () =>
      json({
        secrets: [
          {
            workstationId: ID(20),
            workstationName: 'Desk',
            targetId: ID(40),
            name: 'TEST_USER_EMAIL',
            setAt: new Date().toISOString(),
          },
        ],
      });
    const user = userEvent.setup();
    wrap(
      <TargetTesting
        projectId={PROJECT}
        target={
          target({ testEnabled: true, secretNames: ['TEST_USER_EMAIL', 'TEST_USER_PASSWORD'] }) as never
        }
        workstations={[ws()]}
      />,
    );
    expect(await screen.findByPlaceholderText('set: type to replace')).toBeInTheDocument(); // the email has a value already
    const input = screen.getByTestId('secret-TEST_USER_PASSWORD');
    expect(screen.getByTestId('secret-save-TEST_USER_PASSWORD')).toBeDisabled();
    await user.type(input, 'hunter2-hunter2');
    await user.click(screen.getByTestId('secret-save-TEST_USER_PASSWORD'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    const sent = calls.find((c) => c.method === 'PUT')!.body;
    expect(sent).toMatchObject({ targetId: ID(40), name: 'TEST_USER_PASSWORD', keyId: 'abcd1234abcd1234' });
    expect(JSON.stringify(sent)).not.toContain('hunter2');
    // what was sent opens with the private key and holds the value
    const plain = new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: 'RSA-OAEP' },
        pair.privateKey,
        Uint8Array.from(atob(sent.ciphertext), (c) => c.charCodeAt(0)),
      ),
    );
    expect(plain).toBe('hunter2-hunter2');
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('says so when you have no workstation to hold the accounts', () => {
    wrap(
      <TargetTesting
        projectId={PROJECT}
        target={target({ secretNames: ['X'] }) as never}
        workstations={[ws({ mine: false })]}
      />,
    );
    expect(screen.getByText(/no workstation to hold the test accounts/)).toBeInTheDocument();
  });
});
