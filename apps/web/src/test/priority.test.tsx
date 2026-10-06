import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PriorityPicker } from '../components/ui.tsx';
import { priorityLabel, priorityLevel } from '../lib/priority.ts';

describe('priority labels', () => {
  it('maps the stored numbers to the four labels', () => {
    expect([1, 3, 5, 8].map(priorityLabel)).toEqual(['Urgent', 'High', 'Normal', 'Low']);
  });
  it('shows in-between values as the nearest label', () => {
    expect([2, 4, 6, 7, 9].map(priorityLabel)).toEqual(['Urgent', 'High', 'Normal', 'Low', 'Low']);
    expect(priorityLevel(4).value).toBe(3);
  });
});

describe('PriorityPicker', () => {
  it('selects the nearest level and reports the numeric value', () => {
    const onChange = vi.fn();
    render(<PriorityPicker value={2} onChange={onChange} />);
    expect(screen.getByRole('radio', { name: 'Urgent' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Low' }));
    expect(onChange).toHaveBeenCalledWith(8);
  });
  it('offers Any for filters', () => {
    const onChange = vi.fn();
    render(<PriorityPicker allowAny value={null} onChange={onChange} />);
    expect(screen.getByRole('radio', { name: 'Any' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'High' }));
    expect(onChange).toHaveBeenCalledWith(3);
  });
});
