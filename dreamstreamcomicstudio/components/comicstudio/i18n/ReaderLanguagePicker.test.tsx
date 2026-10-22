import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReaderLanguagePicker } from './ReaderLanguagePicker';
import { LanguageSwitch } from './LanguageSwitch';

const options = [
  { code: 'en', label: 'English', native: 'English', status: 'ready' as const },
  { code: 'te', label: 'Telugu', native: 'తెలుగు', status: 'ready' as const },
  { code: 'ur', label: 'Urdu', native: 'اردو', status: 'ready' as const }
];

describe('ReaderLanguagePicker', () => {
  it('a draft edition in the owner preview shows how much is translated, in the reader language', () => {
    render(<ReaderLanguagePicker current="en" options={[options[0], { code: 'hi', label: 'Hindi', native: 'हिन्दी', percent: 92 }]} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /English/ }));
    expect(screen.getAllByRole('option')[1].textContent).toContain('92% translated');
    expect(screen.getAllByRole('option')[0].textContent).not.toContain('translated');
  });

  it('renders nothing for a single language', () => {
    const { container } = render(<ReaderLanguagePicker current="en" options={[options[0]]} onChange={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the current endonym; the list has endonyms, English names and "Original" on the source', () => {
    render(<ReaderLanguagePicker current="te" options={options} onChange={vi.fn()} />);
    const button = screen.getByRole('button', { name: /Telugu/ });
    expect(button).toHaveTextContent('తెలుగు');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    const list = screen.getByRole('listbox');
    const items = screen.getAllByRole('option');
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('English'), expect.stringContaining('తెలుగు'), expect.stringContaining('اردو')]);
    expect(items[0].textContent).toContain('అసలు'); // "Original" in the reader's current language
    expect(items[1].getAttribute('aria-selected')).toBe('true');
    expect(list.querySelector('[lang="ur"]')?.getAttribute('dir')).toBe('rtl');
  });

  it('keyboard: arrows move, Enter picks, Esc closes and returns focus', () => {
    const onChange = vi.fn();
    render(<ReaderLanguagePicker current="en" options={options} onChange={onChange} />);
    const button = screen.getByRole('button', { name: /Language/ });
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list.getAttribute('aria-activedescendant')).toMatch(/-2$/);
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('ur');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('picking the current language does not fire onChange; clicking outside closes', () => {
    const onChange = vi.fn();
    render(
      <div>
        <ReaderLanguagePicker current="en" options={options} onChange={onChange} />
        <p>outside</p>
      </div>
    );
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getAllByRole('option')[0]);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('LanguageSwitch', () => {
  it('a radiogroup of editions; arrows move and select; hidden with one option', () => {
    const onChange = vi.fn();
    const opts = [
      { code: 'en', label: 'EN', title: 'English (original)' },
      { code: 'te', label: 'తెలుగు', title: 'Telugu' },
      { code: 'hi', label: 'हिन्दी', title: 'Hindi — draft', draft: true }
    ];
    const { rerender, container } = render(<LanguageSwitch options={opts} value="en" onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('te');
    fireEvent.keyDown(radios[0], { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('hi');
    expect(radios[2].textContent).toContain('(draft)');
    rerender(<LanguageSwitch options={[opts[0]]} value="en" onChange={onChange} />);
    expect(container.innerHTML).toBe('');
  });
});
