import { render } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';

import { Button } from './Button.js';
import { Input } from './Input.js';

/**
 * Automated accessibility checks (WCAG 2.1 A/AA) on the shared primitives via
 * axe-core. These primitives back every form in the web/admin apps, so catching
 * a regression here (a missing label, a broken aria wiring) is the cheapest place
 * to catch it.
 *
 * color-contrast is disabled: axe computes it from rendered layout, which the
 * happy-dom test environment does not produce. Contrast is covered by the design
 * tokens + the Lighthouse/pa11y jobs that run against a real rendered staging
 * build (.github/workflows/dast-and-quality.yml).
 */
async function expectNoA11yViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
  });
  const summary = results.violations.map((v) => `${v.id}: ${v.help}`);
  expect(summary).toEqual([]);
}

describe('a11y (axe-core)', () => {
  it('Button has no detectable violations', async () => {
    const { container } = render(<Button>Run kill sheet</Button>);
    await expectNoA11yViolations(container);
  });

  it('Input wires label + aria with no violations', async () => {
    const { container } = render(
      <Input label="Mud weight (ppg)" hint="Surface to TD" name="mud-weight" />,
    );
    await expectNoA11yViolations(container);
  });

  it('Input in error state keeps aria-invalid + described-by valid', async () => {
    const { container } = render(
      <Input label="Casing pressure" error="Required" name="casing-pressure" />,
    );
    await expectNoA11yViolations(container);
  });
});
