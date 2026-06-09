import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StudioPlanThinking, PLAN_AGENTS } from './StudioPlanThinking';

describe('StudioPlanThinking', () => {
  it('shows the whole engineering team thinking and the checklist framing', () => {
    render(<StudioPlanThinking />);
    expect(screen.getByText(/drafting the plan/i)).toBeTruthy();
    // Every specialist's activity line renders, so the wait shows real work, not a bare spinner.
    for (const agent of PLAN_AGENTS) {
      expect(screen.getByText(agent.line)).toBeTruthy();
    }
    expect(screen.getByText(/build checklist/i)).toBeTruthy();
  });
});
