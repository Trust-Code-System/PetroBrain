import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WorkingPanel } from './WorkingPanel';

describe('WorkingPanel task card', () => {
  it('renders a structured task confirmation without raw JSON', () => {
    render(
      <WorkingPanel
        tool="create_task"
        input={{}}
        result={{
          task_id: 'task-1',
          title: 'Prepare draft GHG inventory report',
          assigned_to_team: 'Emissions',
          recurrence_type: 'monthly',
          next_run_at: '2026-07-06T08:00:00Z',
          category: 'ghg_inventory_preparation',
          status: 'active',
        }}
      />,
    );

    expect(screen.getByText('Prepare draft GHG inventory report')).toBeInTheDocument();
    expect(screen.getByText('Emissions')).toBeInTheDocument();
    expect(screen.getByText('monthly')).toBeInTheDocument();
    expect(screen.getByText(/External email and calendar delivery is not enabled/)).toBeInTheDocument();
    expect(screen.queryByText(/"task_id"/)).not.toBeInTheDocument();
  });
});
