import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { useChatStore } from '@/lib/chat/store';

import { ModulePill } from './ModulePill';

afterEach(() => {
  act(() => {
    useChatStore.setState({ module: 'auto', modulePinned: false, token: null });
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
      expect(screen.getByRole('button', { name: /Research/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /General/i })).not.toBeInTheDocument();
    view.unmount();
    queryClient.clear();
  });

  it('shows Auto by default and lists every routing choice', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ModulePill />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: /Auto/ }));
    expect(screen.getByText('Automatically routes each question to the best PetroBrain module.')).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('Research')).toBeInTheDocument();
    expect(screen.getByText('Well Control')).toBeInTheDocument();
    expect(screen.getByText('Emissions / MRV')).toBeInTheDocument();
    expect(screen.getByText('PTW')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
    queryClient.clear();
  });

  it('allows a specialist module to be pinned', async () => {
    const user = userEvent.setup();
    act(() => {
      useChatStore.setState({ module: 'research', modulePinned: false, token: null });
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ModulePill />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: /Research/ }));
    await user.click(screen.getByRole('switch', { name: /Pin this module/ }));
    expect(useChatStore.getState().modulePinned).toBe(true);
    queryClient.clear();
  });
});
