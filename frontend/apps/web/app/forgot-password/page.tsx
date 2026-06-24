import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ForgotPasswordForm } from '@/lib/auth/ForgotPasswordForm';

export const metadata: Metadata = {
  title: 'PetroBrain - Reset password',
  description: 'Request a link to reset your PetroBrain password.',
};

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ForgotPasswordForm />
    </Suspense>
  );
}
