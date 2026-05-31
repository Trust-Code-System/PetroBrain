import type { Metadata } from 'next';
import { Suspense } from 'react';

import { CustomizeClient } from './CustomizeClient';

export const metadata: Metadata = {
  title: 'PetroBrain - Customize',
  description: 'Skills, connectors and plugins for oil & gas operations.',
};

export default function CustomizePage() {
  return (
    <Suspense fallback={null}>
      <CustomizeClient />
    </Suspense>
  );
}
