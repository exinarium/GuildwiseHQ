import { BUILTIN_ROLES, uxDesignerRole } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsertStepForm } from '../components/builder/InsertStepForm.tsx';
import { RoleSetPanel } from '../components/org/RoleSetPanel.tsx';

afterEach(() => vi.unstubAllGlobals());

const DESK = '01900000-0000-7000-8000-000000000001';

function mount(status: Record<string, unknown>, canEdit = true) {
  const calls: Array<[string, string, unknown]> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? 'GET', url, init?.body ? JSON.parse(init.body as string) : undefined]);
      const body =
        init?.method === 'PUT'
          ? { ...status, roleSet: 'bmad', pack: 'bmad-method', pendingDeskItemId: DESK }
          : status;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RoleSetPanel canEdit={canEdit} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

const stock = { roleSet: 'guildwise', pack: null, pendingDeskItemId: null, roles: [] };

describe('Role set on Roles & workflows', () => {
  it('shows the stock roles and switches to BMAD (an approval on the desk)', async () => {
    const user = userEvent.setup();
    const calls = mount(stock);
    const panel = await screen.findByTestId('role-set');
    expect(panel).toHaveTextContent('Guildwise (stock roles)');
    const button = within(panel).getByRole('button', { name: 'Switch' });
    expect(button).toBeDisabled();
    await user.selectOptions(within(panel).getByLabelText('Run the roles of'), 'bmad');
    await user.click(within(panel).getByRole('button', { name: 'Switch' }));
    await waitFor(() =>
      expect(calls.find(([m]) => m === 'PUT')).toEqual(['PUT', '/api/org/role-set', { roleSet: 'bmad' }]),
    );
  });

  it('while the set waits for approval it links to the desk and offers no switch', async () => {
    mount({ roleSet: 'bmad', pack: 'bmad-method', pendingDeskItemId: DESK, roles: [] });
    const panel = await screen.findByTestId('role-set');
    expect(within(panel).getByTestId('role-set-pending')).toHaveTextContent('Waiting for approval');
    expect(within(panel).getByRole('link', { name: 'Approve the role set on the desk' })).toHaveAttribute(
      'href',
      '/desk',
    );
    expect(within(panel).queryByRole('button')).toBeNull();
    expect(panel).toHaveTextContent('pack bmad-method');
  });

  it('someone who cannot edit the catalogue only sees it', async () => {
    mount({ roleSet: 'bmad', pack: 'bmad-method', pendingDeskItemId: null, roles: [] }, false);
    const panel = await screen.findByTestId('role-set');
    expect(panel).toHaveTextContent('BMAD Method');
    expect(within(panel).queryByRole('button')).toBeNull();
  });
});

describe('Insert a step: UX design', () => {
  it('is offered when the UX designer role exists and adds the conditional step after planning', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <InsertStepForm
        after={{ id: 'planning', label: 'Planning' }}
        variantKey="code-ux"
        roles={[...BUILTIN_ROLES, uxDesignerRole()]}
        taken={[]}
        onAdd={onAdd}
        onCancel={() => {}}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Template'), 'ux');
    expect(screen.getByLabelText('Label')).toHaveValue('UX design');
    expect(screen.getByLabelText('Role')).toHaveValue('ux_designer');
    await user.click(screen.getByRole('button', { name: 'Add step' }));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        after: 'planning',
        stage: expect.objectContaining({
          id: 'ux_design',
          claimRole: 'ux_designer',
          when: { field: 'designNeeded', equals: true },
        }),
      }),
    );
  });

  it('is not offered without the role', () => {
    render(
      <InsertStepForm
        after={{ id: 'planning', label: 'Planning' }}
        variantKey="code-ux"
        roles={BUILTIN_ROLES}
        taken={[]}
        onAdd={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole('option', { name: /UX design/ })).toBeNull();
  });
});
