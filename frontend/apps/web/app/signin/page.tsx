import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AuthForm } from '@/lib/auth/AuthForm';

export const metadata: Metadata = {
  title: 'PetroBrain - Sign in',
  description: 'Sign in to the PetroBrain operations console.',
};

export default function SigninPage() {
  return (
    <Suspense fallback={null}>
      <AuthForm mode="signin" />
    </Suspense>
  );
}
