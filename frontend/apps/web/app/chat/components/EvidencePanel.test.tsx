import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EvidencePanel } from './EvidencePanel';


describe('EvidencePanel', () => {
  it('ignores an incomplete evidence pack instead of crashing the app', () => {
    expect(() => render(<EvidencePanel evidence={{} as never} />)).not.toThrow();
    expect(screen.queryByText('Verification')).not.toBeInTheDocument();
  });

  it('shows confidence, decision-support advisory, and source quality', () => {
    render(
      <EvidencePanel
        evidence={{
          confidence: { label: 'High', reason: 'Primary evidence supports the main claims.' },
          checked: ['Reviewed one governed source.'],
          not_verified: ['Site-specific economics were not verified.'],
          sources: [{
            type: 'web',
            label: 'NUPRC licensing update',
            url: 'https://nuprc.gov.ng/licensing',
            reliability: 'primary',
            quality_score: 100,
            freshness: 'current',
          }],
          calculations: [],
          safety: { requires_human_verification: false, message: '' },
          advisory: {
            required: true,
            message: 'Draft / decision support. Review with the responsible authority.',
          },
        }}
      />,
    );

    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText(/Draft \/ decision support/)).toBeInTheDocument();
    expect(screen.getByText(/primary 100\/100/)).toBeInTheDocument();
    expect(screen.getByText('Not verified')).toBeInTheDocument();
  });
});
