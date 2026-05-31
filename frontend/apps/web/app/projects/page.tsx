import type { Metadata } from 'next';

import { ProjectsClient } from './ProjectsClient';

export const metadata: Metadata = {
  title: 'PetroBrain - Projects',
  description: 'Project workspaces for grouping chats with shared instructions.',
};

export default function ProjectsPage() {
  return <ProjectsClient />;
}
