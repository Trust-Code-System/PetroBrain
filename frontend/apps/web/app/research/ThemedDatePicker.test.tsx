import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ThemedDatePicker } from './ThemedDatePicker';

describe('ThemedDatePicker', () => {
  it('uses the branded calendar and returns an ISO date', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <ThemedDatePicker
        label="From date"
        value="2026-06-06"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: /06\/06\/2026/i }));
    expect(screen.getByRole('dialog', { name: 'From date calendar' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '15 June 2026' }));
    expect(onChange).toHaveBeenCalledWith('2026-06-15');
  });

  it('clears the selected date without opening a native date input', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <ThemedDatePicker
        label="To date"
        value="2026-06-30"
        onChange={onChange}
      />,
    );

    expect(document.querySelector('input[type="date"]')).toBeNull();
    const trigger = screen.getByRole('button', { name: /30\/06\/2026/i });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenCalledWith('');
    expect(trigger).toHaveFocus();
  });

  it('associates its label and rejects calendar-rollover dates', () => {
    render(
      <ThemedDatePicker
        label="From date"
        value="2026-02-31"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('From date')).toHaveTextContent('dd/mm/yyyy');
  });
});
