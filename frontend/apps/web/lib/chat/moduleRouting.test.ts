import { describe, expect, it } from 'vitest';

import { routeModule } from './moduleRouting';

describe('routeModule', () => {
  it.each([
    ["Run a deep research report on Nigeria's gas flare commercialization.", 'research'],
    ['Give me a full overview of the Nigerian upstream sector. Cite sources.', 'research'],
    ['Prepare a licensing-round opportunity brief for investors.', 'research'],
    ['Create a PTW for hot work.', 'ptw'],
    ['Calculate flaring emissions for this source.', 'emissions_mrv'],
    ['Create a kill sheet for this well.', 'well_control'],
  ] as const)('routes "%s" to %s', (prompt, expected) => {
    expect(routeModule(prompt, 'auto').resolvedModule).toBe(expected);
  });

  it('preserves an explicitly selected module when no stronger intent is present', () => {
    expect(routeModule('Explain OPEC.', 'research').resolvedModule).toBe('research');
  });

  it('switches between unpinned specialist modules on clear intent', () => {
    expect(
      routeModule('Calculate flaring emissions.', 'research').resolvedModule,
    ).toBe('emissions_mrv');
    expect(
      routeModule('Run a deep research report on licensing.', 'emissions_mrv').resolvedModule,
    ).toBe('research');
  });

  it('keeps a pinned module and returns a conflict warning', () => {
    const decision = routeModule('Create a kill sheet using SIDPP.', 'ptw', { pinned: true });
    expect(decision.resolvedModule).toBe('ptw');
    expect(decision.notice).toBe(
      'This question appears to match Well Control, but PTW is pinned.',
    );
  });

  it('routes attachment analysis to Documents', () => {
    expect(
      routeModule('Summarize this document.', 'auto', { hasAttachments: true }).resolvedModule,
    ).toBe('documents');
  });

  it('keeps ambiguous auto questions in General with low confidence', () => {
    const decision = routeModule('Explain what OPEC is.', 'auto');
    expect(decision.resolvedModule).toBe('general');
    expect(decision.confidence).toBe('low');
  });
});
