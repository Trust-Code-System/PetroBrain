import { Providers } from '@/lib/chat/Providers';

import { AdminDocumentsClient } from './AdminDocumentsClient';

/**
 * /admin/documents - SSR shell.
 *
 * Auth + role decisions happen in the client so the same QueryClient
 * lifecycle covers polling and mutations. The server frame is a pure
 * static layout (no per-user state).
 */
export const dynamic = 'force-dynamic';

export default function AdminDocumentsPage() {
  return (
    <Providers>
      <AdminDocumentsClient />
    </Providers>
  );
}
