import { Providers } from '@/lib/chat/Providers';

import { SharePageClient } from './SharePageClient';

export default function SharePage() {
  return (
    <Providers>
      <SharePageClient />
    </Providers>
  );
}
