import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { OutputSection } from '../components/schedules/OutputSection.tsx';
import { draftsFrom, emptyOutput, type OutputDraft } from '../lib/schedules.ts';

function Harness({ initial = [] as OutputDraft[] }: { initial?: OutputDraft[] }) {
  const [outputs, setOutputs] = useState(initial);
  return <OutputSection outputs={outputs} onChange={setOutputs} errors={{}} workstations={[]} />;
}

function renderSection(initial: OutputDraft[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Harness initial={initial} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OutputSection', () => {
  it('is off until a destination is added, then shows touch-friendly inputs and no secret field', async () => {
    renderSection();
    expect(screen.queryByTestId('output-0')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /add a destination/i }));
    const row = screen.getByTestId('output-0');
    expect(row.querySelector('input[type="email"]')?.getAttribute('inputmode')).toBe('email');
    await userEvent.selectOptions(screen.getByLabelText(/send it to/i), 'webhook');
    expect(screen.getByTestId('output-0').querySelector('input[type="url"]')?.getAttribute('inputmode')).toBe(
      'url',
    );
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('removes a destination and stops at five', async () => {
    renderSection([emptyOutput(), emptyOutput(), emptyOutput(), emptyOutput(), emptyOutput()]);
    expect(screen.queryByRole('button', { name: /add a destination/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove destination 5' }));
    expect(screen.getByRole('button', { name: /add a destination/i })).toBeTruthy();
    expect(screen.queryByTestId('output-4')).toBeNull();
  });

  it('phone destinations use the tel keyboard', () => {
    renderSection(
      draftsFrom([{ kind: 'whatsapp', workstationId: '', instance: '', to: ['+27821234567'] } as never]),
    );
    expect(screen.getByLabelText(/to numbers/i).getAttribute('inputmode')).toBe('tel');
  });
});
