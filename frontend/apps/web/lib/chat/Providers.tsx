'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { useTokenRefresh } from '@/lib/auth/useTokenRefresh';

/** Headless: keeps the access token fresh while signed in. Renders nothing. */
function SessionRefresher() {
  useTokenRefresh();
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  // Construct once per browser session; React Query owns its cache lifetime.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <SessionRefresher />
      {children}
    </QueryClientProvider>
  );
}
