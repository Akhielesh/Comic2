// Logs store + console coverage (S1.5).

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useStudioLogs, MAX_LOG_ENTRIES, __resetLogSeq } from './logsStore';
import { LogsConsole } from './LogsConsole';

beforeEach(() => {
  useStudioLogs.setState({ entries: [] });
  __resetLogSeq();
});

describe('logs store', () => {
  it('appends entries with level + text and increasing ids', () => {
    const { append } = useStudioLogs.getState();
    append('info', 'first');
    append('error', 'second');
    const { entries } = useStudioLogs.getState();
    expect(entries.map((e) => e.text)).toEqual(['first', 'second']);
    expect(entries[0].level).toBe('info');
    expect(entries[1].level).toBe('error');
    expect(entries[1].id).toBeGreaterThan(entries[0].id);
  });

  it('caps the buffer at MAX_LOG_ENTRIES (drops oldest)', () => {
    const { append } = useStudioLogs.getState();
    for (let i = 0; i < MAX_LOG_ENTRIES + 10; i++) append('info', `line ${i}`);
    const { entries } = useStudioLogs.getState();
    expect(entries.length).toBe(MAX_LOG_ENTRIES);
    expect(entries[0].text).toBe('line 10'); // first 10 dropped
    expect(entries[entries.length - 1].text).toBe(`line ${MAX_LOG_ENTRIES + 9}`);
  });

  it('clear empties the buffer', () => {
    const { append, clear } = useStudioLogs.getState();
    append('info', 'x');
    clear();
    expect(useStudioLogs.getState().entries).toEqual([]);
  });
});

describe('LogsConsole', () => {
  it('shows an empty state, then renders + clears entries', () => {
    render(<LogsConsole />);
    expect(screen.getByText(/no output yet/i)).toBeInTheDocument();

    act(() => { useStudioLogs.getState().append('success', 'Preview ready'); });
    expect(screen.getByText('Preview ready')).toBeInTheDocument();
    expect(screen.queryByText(/no output yet/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Clear console'));
    expect(screen.getByText(/no output yet/i)).toBeInTheDocument();
  });
});
