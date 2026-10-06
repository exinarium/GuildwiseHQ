import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, EmptyState, Tabs, ToastProvider, useToast } from '../components/ui.tsx';

function Harness() {
  const [v, setV] = useState('a');
  return (
    <Tabs
      label="Sections"
      prefix="t"
      value={v}
      onChange={setV}
      tabs={[
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
        { id: 'c', label: 'Gamma' },
      ]}
    />
  );
}

describe('Tabs', () => {
  it('moves selection and focus with the arrow keys, Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    alpha.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('tabindex', '-1');
  });
});

describe('ConfirmDialog', () => {
  it('states the question, repeats the verb and confirms', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Fire Marlowe?"
        description="Their cards are released."
        confirmLabel="Fire agent"
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Fire Marlowe?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fire agent' }));
    expect(onConfirm).toHaveBeenCalled();
  });
});

describe('Toast', () => {
  function Fire() {
    const t = useToast();
    return (
      <>
        <button type="button" onClick={() => t.success('Settings saved')}>
          ok
        </button>
        <button type="button" onClick={() => t.error('Could not save')}>
          bad
        </button>
      </>
    );
  }
  it('announces success politely and errors as alerts', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Fire />
      </ToastProvider>,
    );
    await user.click(screen.getByText('ok'));
    expect(screen.getByRole('status')).toHaveTextContent('Settings saved');
    await user.click(screen.getByText('bad'));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save');
  });
});

describe('EmptyState', () => {
  it('keeps the test id on its root and renders the action', () => {
    render(
      <EmptyState
        data-testid="x-empty"
        title="Nothing yet"
        description="Create one."
        action={<button type="button">Create</button>}
      />,
    );
    expect(screen.getByTestId('x-empty')).toHaveTextContent('Nothing yet');
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });
});
