import { DeliverySetupSchema, type MoveDto, type SetupStateDto, sshShipEnv } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoveWizard } from '../components/delivery/move/MoveWizard.tsx';
import { OldServers } from '../components/delivery/setup/DeploySetup.tsx';
import { ToastProvider } from '../components/ui.tsx';

// Moving to a new server (design v3), web: the plain-language flow from "choose the new server" to "make it live", and the Owner's
// "Retire" of the old server. The server is a fake `fetch`; nothing here reaches a network.
const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PROJECT = ID(1);
const WS = ID(20);
const OLD = ID(31);
const NEW = ID(32);
const base = `/api/projects/${PROJECT}`;

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

const setup = DeliverySetupSchema.parse({
  environments: [
    sshShipEnv(
      {
        name: 'production',
        label: 'Live site',
        target: 'Live site',
        host: 'prod',
        composeFile: '/opt/shop/docker-compose.yml',
        service: 'app',
        imageName: 'shop',
        imageVar: 'SHOP_IMAGE',
        healthUrl: 'https://shop.example.com/ready',
        appUrl: 'https://shop.example.com',
        database: { service: 'postgres', dir: '/opt/shop/backups' },
      },
      undefined,
    ),
  ],
});
const env = setup.environments[0]!;
const target = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: 'remote_ssh' as const,
  production: false,
  workstationId: WS,
  workstationName: 'Office PC',
  workstationOnline: true,
  host: `alias-${name}`,
  appUrl: null,
  connection: null,
  keys: [],
  role: 'active' as const,
  ...over,
});
const report = (over: Record<string, unknown> = {}) => ({
  scope: 'ssh_target',
  at: '2026-10-21T10:00:00.000Z',
  host: 'alias-new',
  docker: { installed: true, usable: true, version: '27' },
  containers: [],
  composeFiles: [],
  volumes: [],
  folders: [{ path: '/opt/shop', exists: true, entries: ['backups'] }],
  backups: [{ dir: '/opt/shop/backups', count: 0 }],
  proxies: [],
  urls: [],
  listeners: [],
  ...over,
});
const state = (over: Partial<SetupStateDto> = {}): SetupStateDto =>
  ({
    canEdit: true,
    canApprove: true,
    draft: null,
    current: {
      setup,
      handEdited: [],
      recipePresent: true,
      recipeStatus: 'approved',
      observedHash: 'h',
      approvedHash: 'h',
      lint: [],
      dryRunOk: ['production'],
      dryRunMissing: [],
      custom: false,
    },
    publish: null,
    targets: [target(OLD, 'Live site', { production: true }), target(NEW, 'New server')],
    workstations: [
      {
        id: WS,
        name: 'Office PC',
        connected: true,
        mine: true,
        canProbe: true,
        blocked: null,
        canConnect: true,
        canMove: true,
      },
    ],
    probes: [],
    writeBlocked: null,
    scan: null,
    scanProblem: null,
    proposal: null,
    generator: 'setup-1.3',
    improvedAvailable: false,
    ...over,
  }) as SetupStateDto;

const move = (over: Partial<MoveDto> = {}): MoveDto => ({
  id: ID(90),
  projectId: PROJECT,
  envName: 'production',
  fromTargetId: OLD,
  fromName: 'Live site',
  toTargetId: NEW,
  toName: 'New server',
  workstationId: WS,
  workstationName: 'Office PC',
  state: 'preparing',
  currentStep: 'check',
  steps: [],
  error: null,
  oldAppStopped: false,
  facts: {},
  domain: 'shop.example.com',
  newAddresses: ['203.0.113.9'],
  startedAt: '2026-10-21T10:00:00.000Z',
  finishedAt: null,
  ...over,
});
const done = (step: string, text: string): MoveDto['steps'][number] => ({
  step: step as MoveDto['steps'][number]['step'],
  ok: true,
  detail: text,
  checks: [{ id: 'c', ok: true, text }],
  at: '2026-10-21T10:01:00.000Z',
});

const wizard = (m: MoveDto | undefined, s = state(), moves: MoveDto[] = m ? [m] : []) => {
  const onClose = vi.fn();
  wrap(
    <MoveWizard
      projectId={PROJECT}
      s={s}
      env={env}
      from={s.targets[0] as never}
      move={m}
      moves={moves}
      onClose={onClose}
    />,
  );
  return onClose;
};

describe('choosing the new server', () => {
  it('lists servers that are connected from the same computer and not in use, and offers to connect a new one', async () => {
    const s = state({
      targets: [...state().targets, target(ID(33), 'Other computer', { workstationId: ID(21) })],
    });
    wizard(undefined, s);
    expect(screen.getByTestId('move-choose')).toBeInTheDocument();
    expect(screen.getByTestId('move-pick-New server')).toHaveTextContent('Already connected from Office PC');
    expect(screen.queryByTestId('move-pick-Other computer')).toBeNull();
    expect(screen.queryByTestId('move-pick-Live site')).toBeNull();
    expect(screen.getByTestId('move-connect-new')).toBeInTheDocument();
  });

  it('looks at the picked server, shows what Guildwise will set up, and starts the move with exactly the two servers and the computer', async () => {
    const user = userEvent.setup();
    const s = state({
      probes: [
        {
          id: ID(70),
          targetId: NEW,
          workstationId: WS,
          workstationName: 'Office PC',
          scope: 'ssh_target',
          host: 'alias-New server',
          at: '2026-10-21T10:00:00.000Z',
          report: report(),
          error: null,
          errorText: null,
        } as never,
      ],
    });
    routes[`POST ${base}/delivery/moves`] = () => json(move(), 201);
    wizard(undefined, s);
    await user.click(screen.getByTestId('move-pick-New server'));
    expect(await screen.findByTestId('move-prepare')).toBeInTheDocument();
    // the folder is the old server's, nothing to type
    expect(screen.getByTestId('prepare-fixed')).toHaveTextContent('/opt/shop');
    expect(screen.queryByTestId('prepare-dir')).toBeNull();
    await user.click(screen.getByTestId('move-start'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/delivery/moves'))?.body).toEqual({
        fromTargetId: OLD,
        toTargetId: NEW,
        workstationId: WS,
      }),
    );
  });

  it('blocks the start when Docker is missing on the new server, and when another computer would be needed', async () => {
    const user = userEvent.setup();
    const probes = [
      {
        id: ID(70),
        targetId: NEW,
        workstationId: WS,
        workstationName: 'Office PC',
        scope: 'ssh_target',
        host: 'alias-New server',
        at: '2026-10-21T10:00:00.000Z',
        report: report({ docker: { installed: false, usable: false } }),
        error: null,
        errorText: null,
      } as never,
    ];
    wizard(undefined, state({ probes }));
    await user.click(screen.getByTestId('move-pick-New server'));
    expect(await screen.findByTestId('move-needs-docker')).toBeInTheDocument();
    expect(screen.getByTestId('move-start')).toBeDisabled();
  });
});

describe('following the move', () => {
  it('while the look and the copy run: the steps in words, nothing about downtime yet', () => {
    wizard(move({ steps: [done('check', 'Docker works')], currentStep: 'copy_config' }));
    expect(screen.getByTestId('move-working')).toHaveTextContent('Nothing is changed on the old server');
    expect(screen.getByTestId('move-step-check')).toBeInTheDocument();
    expect(screen.getByTestId('move-step-copy_config')).toHaveTextContent('Copying the settings file');
    expect(screen.queryByTestId('move-switch')).toBeNull();
  });

  it('a failed look says what is wrong, that the old site runs, and offers Try again and Give up', async () => {
    const user = userEvent.setup();
    routes[`POST ${base}/delivery/moves/${ID(90)}/retry`] = () => json(move(), 202);
    wizard(
      move({
        state: 'failed',
        currentStep: 'check',
        error: 'The database (postgres) is not running on the old server',
        steps: [
          {
            step: 'check' as const,
            ok: false,
            detail: 'x',
            checks: [
              { id: 'database', ok: false, text: 'The database (postgres) is not running on the old server' },
            ],
            at: '2026-10-21T10:01:00.000Z',
          },
        ],
      }),
    );
    expect(screen.getByTestId('move-failed')).toHaveTextContent('postgres');
    expect(screen.getByTestId('move-old-up')).toHaveTextContent('running as before');
    expect(screen.getByTestId('move-checks')).toHaveTextContent('postgres');
    await user.click(screen.getByTestId('move-retry'));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/retry') && c.method === 'POST')).toBe(true),
    );
  });

  it('a failure after the old app was stopped says the site is down and offers to go back', async () => {
    const user = userEvent.setup();
    routes[`POST ${base}/delivery/moves/${ID(90)}/cancel`] = () => json(move(), 202);
    wizard(
      move({
        state: 'failed',
        currentStep: 'start_app',
        oldAppStopped: true,
        error: 'The app did not answer',
      }),
    );
    expect(screen.getByTestId('move-old-down')).toHaveTextContent('still stopped');
    await user.click(screen.getByTestId('move-give-up'));
    await user.click(await screen.findByRole('button', { name: 'Start the old app again' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(true));
  });

  it('ready: explains the downtime in plain words and only a click starts it', async () => {
    const user = userEvent.setup();
    routes[`POST ${base}/delivery/moves/${ID(90)}/switch`] = () => json(move({ state: 'moving' }), 202);
    wizard(move({ state: 'ready', currentStep: 'start_database', steps: [done('check', 'Docker works')] }));
    expect(screen.getByTestId('move-ready')).toHaveTextContent('Live site');
    expect(screen.getByTestId('move-downtime-text')).toHaveTextContent('visitors cannot use the site');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await user.click(screen.getByTestId('move-switch'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/switch'))?.body).toEqual({ agreedDowntime: true }),
    );
  });

  describe('pointing the domain', () => {
    const live = (dns: Record<string, unknown>) => {
      routes[`GET ${base}/delivery/moves/${ID(90)}/dns`] = () =>
        json({
          domain: 'shop.example.com',
          state: 'old',
          expected: ['203.0.113.9'],
          found: ['198.51.100.7'],
          oldAddresses: ['198.51.100.7'],
          at: '2026-10-21T10:05:00.000Z',
          text: 'shop.example.com still points to the old server.',
          ...dns,
        });
    };
    it('says what to change and where, checks it live, and keeps "make it live" off until the domain points here', async () => {
      const user = userEvent.setup();
      live({});
      wizard(move({ state: 'app_ready', currentStep: 'start_app', oldAppStopped: true }));
      expect(screen.getByTestId('move-dns-address')).toHaveTextContent('203.0.113.9');
      expect(screen.getByTestId('move-dns-domain')).toHaveTextContent('shop.example.com');
      expect(await screen.findByTestId('move-dns-state')).toHaveTextContent('Still points to the old server');
      expect(screen.getByTestId('move-dns-text')).toHaveTextContent('still points');
      expect(screen.getByTestId('move-golive')).toBeDisabled();
      // handled another way: allowed, with a warning in the confirmation
      await user.click(screen.getByTestId('move-dns-other'));
      expect(screen.getByTestId('move-golive')).toBeEnabled();
    });

    it('when the domain points to the new server the Owner confirms and the server is asked to verify it', async () => {
      const user = userEvent.setup();
      live({ state: 'new', found: ['203.0.113.9'], text: 'shop.example.com points to the new server.' });
      routes[`POST ${base}/delivery/moves/${ID(90)}/complete`] = () => json(move({ state: 'completed' }));
      wizard(move({ state: 'app_ready', currentStep: 'start_app', oldAppStopped: true }));
      await waitFor(() =>
        expect(screen.getByTestId('move-dns-state')).toHaveTextContent('Points to the new server'),
      );
      await user.click(screen.getByTestId('move-golive'));
      await user.click(await screen.findByRole('button', { name: 'Make it live' }));
      await waitFor(() =>
        expect(calls.find((c) => c.url.endsWith('/complete'))?.body).toEqual({ dns: 'verified' }),
      );
    });

    it('someone who is not the Owner is told to wait for the Owner', async () => {
      live({});
      wizard(move({ state: 'app_ready', currentStep: 'start_app' }), state({ canApprove: false }));
      expect(screen.getByTestId('move-owner-only')).toBeInTheDocument();
      expect(screen.getByTestId('move-golive')).toBeDisabled();
    });

    it('an app without a web name has nothing to point', () => {
      wizard(move({ state: 'app_ready', currentStep: 'start_app', domain: null }));
      expect(screen.getByTestId('move-no-domain')).toBeInTheDocument();
      expect(screen.getByTestId('move-golive')).toBeEnabled();
    });
  });

  it('done: the old server is kept as a fallback and nothing was deleted', () => {
    wizard(move({ state: 'completed', currentStep: null }));
    expect(screen.getByTestId('move-done')).toHaveTextContent('kept as a fallback');
    expect(screen.getByTestId('move-done')).toHaveTextContent('nothing was deleted');
  });
});

describe('old servers: standby and retire', () => {
  const old = state({
    targets: [
      target(NEW, 'Live site'),
      target(OLD, 'Live site (old server)', { role: 'standby' }),
      target(ID(34), 'Ancient', { role: 'retired' }),
    ],
  });
  it('a standby is a fallback that nothing deploys to; a retired server says Guildwise cannot sign in any more', () => {
    wrap(<OldServers projectId={PROJECT} s={old} />);
    expect(screen.getByTestId(`old-server-${OLD}`)).toHaveTextContent('Standby (fallback)');
    expect(screen.getByTestId(`old-server-${OLD}`)).toHaveTextContent('Nothing deploys here any more');
    expect(screen.getByTestId(`old-server-${ID(34)}`)).toHaveTextContent('Retired');
    expect(screen.queryByTestId(`retire-${ID(34)}`)).toBeNull();
  });

  it('retire is the Owner’s: the explanation says only the keys go and nothing is deleted; confirming asks the server', async () => {
    const user = userEvent.setup();
    routes[`POST ${base}/delivery/targets/${OLD}/retire`] = () => json({ commandId: ID(99) }, 202);
    wrap(<OldServers projectId={PROJECT} s={old} />);
    await user.click(screen.getByTestId(`retire-${OLD}`));
    expect(await screen.findByTestId('retire-explainer')).toHaveTextContent('removes the keys it added');
    expect(screen.getByTestId('retire-explainer')).toHaveTextContent('never deletes anything');
    await user.click(screen.getByTestId('retire-confirm'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith(`/targets/${OLD}/retire`))?.body).toEqual({ confirmed: true }),
    );
  });

  it('someone else sees who can do it, not a button', () => {
    wrap(<OldServers projectId={PROJECT} s={{ ...old, canApprove: false }} />);
    expect(screen.queryByTestId(`retire-${OLD}`)).toBeNull();
    expect(screen.getByText('Only the Owner retires a server.')).toBeInTheDocument();
  });

  it('nothing is shown when there is no old server', () => {
    wrap(<OldServers projectId={PROJECT} s={state()} />);
    expect(screen.queryByTestId('old-servers')).toBeNull();
  });
});
