import type { Metadata } from 'next';
import { Suspense } from 'react';

import { SettingsClient } from './SettingsClient';

export const metadata: Metadata = {
  title: 'PetroBrain - Settings',
  description: 'Profile, custom instructions, data controls, and account settings.',
};

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsClient />
    </Suspense>
  );
}
