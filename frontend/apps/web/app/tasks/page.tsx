import type { Metadata } from 'next';

import { Providers } from '@/lib/chat/Providers';
import { TasksClient } from './TasksClient';

export const metadata: Metadata = {
  title: 'PetroBrain - Tasks',
  description: 'Oil and gas compliance and operations reminders.',
};

export default function TasksPage() {
  return <Providers><TasksClient /></Providers>;
}
