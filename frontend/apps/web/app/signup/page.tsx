import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AuthForm } from '@/lib/auth/AuthForm';

export const metadata: Metadata = {
  title: 'PetroBrain - Sign up',
  description: 'Create a PetroBrain operations console account.',
};

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <AuthForm mode="signup" />
    </Suspense>
  );
}
