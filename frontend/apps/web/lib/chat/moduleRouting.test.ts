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
    expect(routeModule(prompt, 'general')).toBe(expected);
  });

  it('preserves an explicitly selected module when no stronger intent is present', () => {
    expect(routeModule('Explain the evidence in this document.', 'research')).toBe('research');
  });
});
