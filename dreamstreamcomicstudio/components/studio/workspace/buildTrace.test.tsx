// Build store + BuildTrace coverage (Sprint 2).

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act as rtlAct } from '@testing-library/react';
import { useStudioBuild } from './buildStore';
import { BuildTrace } from './BuildTrace';

beforeEach(() => useStudioBuild.getState().reset());

describe('build store', () => {
  it('tracks the trace lifecycle', () => {
    const s = useStudioBuild.getState();
    s.begin();
    expect(useStudioBuild.getState().running).toBe(true);
    s.pushEvent({ stage: 'run', iteration: 0, message: 'Installing…' });
    s.pushEvent({ stage: 'fix', iteration: 1, message: 'Fixing missing dep' });
    let st = useStudioBuild.getState();
    expect(st.events.length).toBe(2);
    expect(st.stage).toBe('fix');
    expect(st.iteration).toBe(1);
    s.finish({ ok: true, reason: 'clean', iterations: 1, previewUrl: 'https://x.dev' });
    st = useStudioBuild.getState();
    expect(st.running).toBe(false);
    expect(st.result?.ok).toBe(true);
  });

  it('fail() records the error and stops', () => {
    useStudioBuild.getState().begin();
    useStudioBuild.getState().fail('boom');
    expect(useStudioBuild.getState().running).toBe(false);
    expect(useStudioBuild.getState().error).toBe('boom');
  });
});

describe('BuildTrace', () => {
  it('shows the empty hint, then streamed stages, then the result', () => {
    render(<BuildTrace />);
    expect(screen.getByText(/the steps stream here/i)).toBeInTheDocument();

    rtlAct(() => {
      useStudioBuild.getState().begin();
      useStudioBuild.getState().pushEvent({ stage: 'run', iteration: 0, message: 'Starting dev server' });
    });
    expect(screen.getByText('Starting dev server')).toBeInTheDocument();
    expect(screen.getByText('Run')).toBeInTheDocument();

    rtlAct(() => {
      useStudioBuild.getState().finish({ ok: true, reason: 'clean', iterations: 2, previewUrl: 'https://x.dev' });
    });
    expect(screen.getByText(/built & running/i)).toBeInTheDocument();
  });
});
