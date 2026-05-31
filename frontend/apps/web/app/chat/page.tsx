import { Providers } from '@/lib/chat/Providers';

import { ChatClient } from './ChatClient';

/**
 * /chat - SSR shell. The page itself is a server component that mounts the
 * client shell behind the React-Query provider; nothing on this server
 * frame depends on the user (the token decodes in the browser).
 */
export const dynamic = 'force-dynamic';

export default function ChatPage() {
  return (
    <Providers>
      <ChatClient />
    </Providers>
  );
}
