import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CardShell, Segmented } from './ui';

describe('CardShell', () => {
  it('a long title truncates but stays readable in its title attribute', () => {
    const long = 'Draw 12 pages + 4 sheets on google/gemini-2.5-flash-image-preview-very-long-route-id?';
    render(<CardShell title={long}>body</CardShell>);
    expect(screen.getByText(long)).toHaveAttribute('title', long);
    expect(screen.getByText(long)).toHaveClass('truncate');
  });
});

describe('Segmented', () => {
  const Harness: React.FC<{ initial: string }> = ({ initial }) => {
    const [v, setV] = useState(initial);
    return (
      <Segmented<string>
        label="Reading direction"
        value={v}
        onChange={(next) => setV(next)}
        options={[
          { value: 'ltr', label: 'Left to right' },
          { value: 'rtl', label: 'Right to left (manga)' }
        ]}
      />
    );
  };

  it('labels truncate inside their segment instead of overlapping the neighbour', () => {
    render(<Harness initial="ltr" />);
    const radio = screen.getByRole('radio', { name: 'Right to left (manga)' });
    expect(radio.querySelector('span.truncate.min-w-0')).toHaveTextContent('Right to left (manga)');
    expect(radio).toHaveAttribute('title', 'Right to left (manga)');
  });

  it('roving focus: the checked option is the Tab stop — or the first one when nothing matches', () => {
    const { unmount } = render(<Harness initial="rtl" />);
    expect(screen.getByRole('radio', { name: 'Right to left (manga)' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Left to right' })).toHaveAttribute('tabindex', '-1');
    unmount();
    render(<Harness initial="mixed" />);
    expect(screen.getByRole('radio', { name: 'Left to right' })).toHaveAttribute('tabindex', '0');
  });

  it('arrow keys move and choose, like a native radio group', () => {
    render(<Harness initial="ltr" />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Left to right' }), { key: 'ArrowRight' });
    const rtl = screen.getByRole('radio', { name: 'Right to left (manga)' });
    expect(rtl).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(rtl);
    fireEvent.keyDown(rtl, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Left to right' })).toHaveAttribute('aria-checked', 'true');
  });
});
