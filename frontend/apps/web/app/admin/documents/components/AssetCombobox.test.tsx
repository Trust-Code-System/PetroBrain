import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AssetNode } from '@petrobrain/types';

import { AssetCombobox } from './AssetCombobox';

const ASSETS: AssetNode[] = [
  { id: 'field-a', tenantId: 'demo', parentId: null, type: 'field', name: 'Niger-Delta', attributes: {} },
  { id: 'eq-101', tenantId: 'demo', parentId: 'field-a', type: 'equipment', name: 'Compressor K-101', attributes: {} },
  { id: 'eq-102', tenantId: 'demo', parentId: 'field-a', type: 'equipment', name: 'Compressor K-102', attributes: {} },
];

describe('AssetCombobox', () => {
  it('shows the matching options and picks one', async () => {
    const onChange = vi.fn();
    render(<AssetCombobox label="Asset" value={null} onChange={onChange} assets={ASSETS} />);

    const input = screen.getByRole('combobox', { name: 'Asset' });
    await userEvent.type(input, 'K-101');
    expect(screen.getByText('Compressor K-101')).toBeInTheDocument();
    expect(screen.queryByText('Compressor K-102')).toBeNull();

    await userEvent.click(screen.getByText('Compressor K-101'));
    expect(onChange).toHaveBeenLastCalledWith('eq-101');
  });

  it('supports clearing to "no asset context"', async () => {
    const onChange = vi.fn();
    render(<AssetCombobox label="Asset" value="eq-101" onChange={onChange} assets={ASSETS} />);

    const input = screen.getByRole('combobox', { name: 'Asset' });
    await userEvent.click(input);
    await userEvent.click(screen.getByText('- No asset context -'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('filters by id and type, not only by name', async () => {
    render(<AssetCombobox label="Asset" value={null} onChange={() => {}} assets={ASSETS} />);
    const input = screen.getByRole('combobox', { name: 'Asset' });
    await userEvent.type(input, 'equipment');
    expect(screen.getByText('Compressor K-101')).toBeInTheDocument();
    expect(screen.getByText('Compressor K-102')).toBeInTheDocument();
    expect(screen.queryByText('Niger-Delta')).toBeNull();
  });
});
