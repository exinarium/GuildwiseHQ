import {
  DeliverySetupSchema,
  localAdoptEnv,
  type PlacesResponse,
  type SetupStateDto,
  sshShipEnv,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentCard } from '../components/environments/EnvironmentCard.tsx';
import { allEnvironments, placeProblem, placesFromApi, placesOf } from '../components/environments/model.ts';
import { PlacesPanel } from '../components/environments/PlacesPanel.tsx';
import { ToastProvider } from '../components/ui.tsx';

// The computer that deploys a place was unpaired: the Environments page must keep working (no crash, no blank card), say what
// happened and offer "Choose a computer" instead of a Check that could only fail.
const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PROJECT = ID(1);
const GONE = ID(20); // the removed computer: not in the list of workstations
const NEWPC = ID(21);
const SERVER = ID(31);
const BOX = ID(32);

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
      if (String(url).endsWith('/delivery/setup')) return json(state());
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

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
    localAdoptEnv({
      name: 'uat',
      label: 'Test copy',
      target: 'Test box',
      composeFile: '~/uat/docker-compose.yml',
      composeProject: 'uat',
      service: 'app',
      imageName: 'uat-app',
      appUrl: 'http://localhost:5500',
      database: { service: 'postgres', dir: '~/uat/backups' },
    }),
  ],
});
const target = (id: string, name: string, kind: 'remote_ssh' | 'local_docker', over = {}) => ({
  id,
  name,
  kind,
  production: kind === 'remote_ssh',
  workstationId: GONE,
  workstationName: 'Old PC',
  workstationOnline: false,
  host: kind === 'remote_ssh' ? 'prod' : null,
  appUrl: null,
  connection:
    kind === 'remote_ssh'
      ? { state: 'reachable' as const, at: '2026-10-21T10:00:00.000Z', detail: null }
      : null,
  keys: [],
  role: 'active' as const,
  computerRemoved: true,
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
      dryRunOk: ['production', 'uat'],
      dryRunMissing: [],
      custom: false,
    },
    publish: null,
    // note: the stale "reachable" answer next to the server's computerRemoved flag
    targets: [target(SERVER, 'Live site', 'remote_ssh'), target(BOX, 'Test box', 'local_docker')],
    workstations: [
      {
        id: NEWPC,
        name: 'New PC',
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
    generator: 'setup-1.4',
    improvedAvailable: false,
    ...over,
  }) as SetupStateDto;

const wrap = (el: React.ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>{el}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

const card = (s: SetupStateDto, envName: string) => {
  const places = placesOf(s);
  const item = allEnvironments(s).find((e) => e.env.name === envName)!;
  return wrap(
    <ul>
      <EnvironmentCard
        projectId={PROJECT}
        s={s}
        env={item.env}
        draft={false}
        places={places}
        status={undefined}
        hasPlan={false}
        labelOf={(n) => n}
        changesSinceApproval={[]}
        onAdvanced={() => {}}
      />
    </ul>,
  );
};

describe('the model', () => {
  it('a place the server says lost its computer is a removed computer, whatever the stale reachability says', () => {
    const places = placesOf(state());
    expect(places.every((p) => p.computerRemoved)).toBe(true);
    expect(placeProblem(places.find((p) => p.kind === 'server'))).toMatchObject({
      text: 'The computer for Live site was removed',
      fix: 'reconnect',
    });
    expect(placeProblem(places.find((p) => p.kind === 'computer'))).toMatchObject({ fix: 'change' });
    // a healthy place is not
    const ok = placesOf(
      state({
        targets: [
          target(SERVER, 'Live site', 'remote_ssh', { workstationId: NEWPC, computerRemoved: false }),
        ],
      }),
    );
    expect(ok[0]!.computerRemoved).toBe(false);
    expect(placeProblem(ok[0])).toBeNull();
  });

  it('a computer missing from the active list (a member who left) is not called removed: the server decides', () => {
    // `workstations` lists only the active computers of current members; the place still deploys, so no false alarm
    const places = placesOf(
      state({ targets: [target(SERVER, 'Live site', 'remote_ssh', { computerRemoved: false })] }),
    );
    expect(places[0]!.computerRemoved).toBe(false);
  });

  it('the places the server lists carry the flag too', () => {
    const r = {
      canEdit: true,
      places: [
        {
          id: SERVER,
          name: 'Live site',
          kind: 'server',
          workstationId: NEWPC,
          workstationName: 'New PC',
          workstationOnline: true,
          computerRemoved: true,
          host: 'prod',
          appUrl: null,
          production: true,
          role: 'active',
          reachability: null,
          lastProbeAt: null,
          usedBy: [],
          usedByDraft: [],
          usedByFollowups: 0,
          duplicateOf: null,
          keyCount: 0,
          canRemove: true,
          removeBlockedReason: null,
        },
      ],
    } as unknown as PlacesResponse;
    expect(placesFromApi(r, state())[0]!.computerRemoved).toBe(true);
  });
});

describe('an environment whose computer was removed', () => {
  it('a server: says so, offers Choose a computer, hides Check, and opens the reconnect', async () => {
    const user = userEvent.setup();
    card(state(), 'production');
    expect(screen.getByTestId('env-sentence-production')).toHaveTextContent(
      "This environment's computer was removed. Choose another.",
    );
    expect(screen.getByTestId('env-chip-production')).toHaveTextContent('Computer removed');
    expect(screen.queryByTestId('env-check-production')).toBeNull();
    expect(screen.queryByTestId('env-update-production')).toBeNull();
    expect(screen.queryByTestId('env-release-production')).toBeNull();
    const choose = screen.getByTestId('env-reconnect-production');
    expect(choose).toHaveTextContent('Choose a computer');
    await user.click(choose);
    expect(await screen.findByTestId('connect-server')).toBeInTheDocument();
  });

  it('a computer: the chooser lists the active computers (not places yet) and moves the place to the one picked', async () => {
    const user = userEvent.setup();
    card(state(), 'uat');
    expect(screen.getByTestId('env-sentence-uat')).toHaveTextContent('computer was removed');
    expect(screen.queryByTestId('env-check-uat')).toBeNull();
    await user.click(screen.getByTestId('env-choose-computer-uat'));
    const dialog = await screen.findByTestId('choose-computer-dialog');
    expect(within(dialog).getByTestId('choose-computer-New PC')).toBeInTheDocument();
    expect(within(dialog).queryByText('Old PC')).toBeNull();
    expect(screen.getByTestId('choose-computer-confirm')).toBeDisabled();
    await user.click(within(dialog).getByTestId('choose-computer-New PC'));
    await user.click(screen.getByTestId('choose-computer-confirm'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
        url: `/api/deploy-targets/${BOX}`,
        body: { workstationId: NEWPC },
      }),
    );
  });

  it('someone who is not the project owner is told who can fix it', () => {
    card(state({ canEdit: false }), 'production');
    expect(screen.getByTestId('env-sentence-production')).toBeInTheDocument();
    expect(screen.queryByTestId('env-reconnect-production')).toBeNull();
    expect(screen.getByText('Ask the project owner to reconnect it.')).toBeInTheDocument();
  });

  it('a healthy environment keeps its normal card', () => {
    const s = state({
      workstations: state().workstations.concat([]),
      targets: [
        target(SERVER, 'Live site', 'remote_ssh', {
          workstationId: NEWPC,
          workstationOnline: true,
          computerRemoved: false,
        }),
      ],
    });
    card(s, 'production');
    expect(screen.queryByTestId('env-choose-computer-production')).toBeNull();
    expect(screen.getByTestId('env-sentence-production')).not.toHaveTextContent('was removed');
  });
});

describe('the Places panel', () => {
  it('shows the state and Choose a computer for both kinds, with no Check', async () => {
    const user = userEvent.setup();
    wrap(<PlacesPanel projectId={PROJECT} s={state()} onAddServer={() => {}} />);
    for (const key of ['Live site', 'Test box']) {
      expect(screen.getByTestId(`place-${key}`)).toBeInTheDocument();
      expect(screen.getByTestId(`place-removed-${key}`)).toHaveTextContent('was removed');
      expect(screen.queryByTestId(`place-check-${key}`)).toBeNull();
    }
    expect(screen.getByTestId('place-reconnect-Live site')).toHaveTextContent('Choose a computer');
    await user.click(screen.getByTestId('place-choose-computer-Test box'));
    expect(await screen.findByTestId('choose-computer-dialog')).toBeInTheDocument();
  });
});
