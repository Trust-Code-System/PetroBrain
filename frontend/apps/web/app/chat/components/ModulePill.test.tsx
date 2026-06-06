import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';

import { useChatStore } from '@/lib/chat/store';

import { ModulePill } from './ModulePill';

afterEach(() => {
  act(() => {
    useChatStore.setState({ module: 'general', token: null });
  });
});

describe('ModulePill', () => {
  it('shows Research when routing selects the research module', async () => {
    act(() => {
      useChatStore.setState({ module: 'research', token: null });
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ModulePill />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /RESEARCH/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /General/i })).not.toBeInTheDocument();
    view.unmount();
    queryClient.clear();
  });
});
