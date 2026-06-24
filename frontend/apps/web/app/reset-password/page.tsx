import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ResetPasswordForm } from '@/lib/auth/ResetPasswordForm';

export const metadata: Metadata = {
  title: 'PetroBrain - New password',
  description: 'Choose a new password for your PetroBrain account.',
};

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
