import type { MeResponse } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { OrgBanner } from '../components/shell/OrgBanner.tsx';

const me = (simulation: boolean) =>
  ({
    activeOrg: { id: 'o1', name: 'Test Co', banners: [], simulation },
    guestIn: [],
  }) as unknown as MeResponse;

describe('the simulation banner', () => {
  it('is always shown to everyone in a simulation organization', () => {
    render(
      <MemoryRouter>
        <OrgBanner me={me(true)} project={null} />
      </MemoryRouter>,
    );
    const b = screen.getByTestId('simulation-banner');
    expect(b.textContent).toMatch(/Simulation/);
    expect(b.textContent).toMatch(/nothing real is built/);
  });

  it('is not shown in a real organization', () => {
    render(
      <MemoryRouter>
        <OrgBanner me={me(false)} project={null} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('simulation-banner')).toBeNull();
  });
});
