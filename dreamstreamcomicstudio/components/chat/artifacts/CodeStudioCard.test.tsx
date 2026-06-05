// S0.2 acceptance: the code_studio card collapses to a single run CTA ("Open in Code Studio")
// that hands the app off to the studio route — no competing "Build in Studio" / "Quick preview".

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CodeStudioCard } from './CodeStudioCard';
import { useStudioHandoff } from '../../../services/studioHandoff';
import type { CodeStudioArtifact } from '../../../apiTypes';

const artifact: CodeStudioArtifact = {
  title: 'Todo App',
  description: 'Add and check off todos',
  template: 'react-ts',
  files: [{ path: '/App.tsx', content: 'export const App = () => null;' }],
};

beforeEach(() => {
  useStudioHandoff.setState({ artifact: null, requestId: 0 });
});

describe('CodeStudioCard', () => {
  it('shows a single "Open in Code Studio" run CTA (no legacy run buttons)', () => {
    render(<CodeStudioCard data={artifact} />);
    expect(screen.getByRole('button', { name: /open in code studio/i })).toBeInTheDocument();
    expect(screen.queryByText(/build in studio/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/quick preview/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/run live/i)).not.toBeInTheDocument();
  });

  it('hands the app off to Code Studio when the CTA is clicked', () => {
    render(<CodeStudioCard data={artifact} />);
    expect(useStudioHandoff.getState().requestId).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /open in code studio/i }));
    const state = useStudioHandoff.getState();
    expect(state.requestId).toBe(1);
    expect(state.artifact).toEqual(artifact);
  });
});
