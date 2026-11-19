// @vitest-environment jsdom
// The appearance control (navtheme NT-Q): Light · Dark · Paper · System as a ds Segmented, and an icon button that
// names the current look and opens a small panel with the same choice.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppearanceButton, AppearanceSegmented } from './AppearanceControl';

const root = document.documentElement;

afterEach(() => {
  cleanup();
  localStorage.clear();
  root.classList.remove('dark', 'ds-no-transitions');
  root.removeAttribute('data-comic-theme');
});

const radios = (group: HTMLElement) => within(group).getAllByRole('radio').map((r) => r.textContent);

describe('AppearanceSegmented', () => {
  it('offers Light, Dark, Paper and System with paper, and Light, Dark and System without', () => {
    const { unmount } = render(<AppearanceSegmented paper />);
    const group = screen.getByRole('radiogroup', { name: 'Appearance' });
    expect(radios(group)).toEqual(['Light', 'Dark', 'Paper', 'System']);
    expect(within(group).getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    unmount();
    render(<AppearanceSegmented />);
    expect(radios(screen.getByRole('radiogroup', { name: 'Appearance' }))).toEqual(['Light', 'Dark', 'System']);
  });

  it('choosing Dark puts .dark on <html> at once and checks Dark; Paper takes the light mode and the Paper material', () => {
    render(<AppearanceSegmented paper />);
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(root.classList.contains('dark')).toBe(true);
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Paper' }));
    expect(root.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('ds.comic-theme.v1')).toBe('paper');
    expect(screen.getByRole('radio', { name: 'Paper' })).toHaveAttribute('aria-checked', 'true');
  });

  it('a legacy Dark + Paper browser checks nothing, so pressing Dark (what it reads as) still writes Dark with Atlas', () => {
    localStorage.setItem('ds.theme.v1', 'dark');
    localStorage.setItem('ds.comic-theme.v1', 'paper');
    render(<AppearanceSegmented paper />);
    const group = screen.getByRole('radiogroup', { name: 'Appearance' });
    expect(within(group).getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')).toEqual([]);
    // The group stays reachable: the first choice takes the tab stop.
    expect(within(group).getByRole('radio', { name: 'Light' })).toHaveAttribute('tabindex', '0');
    fireEvent.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect([localStorage.getItem('ds.theme.v1'), localStorage.getItem('ds.comic-theme.v1')]).toEqual(['dark', 'atlas']);
    expect(within(group).getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  });

  it('two controls on one page stay in step, and a change from another tab shows at once', () => {
    render(
      <>
        <AppearanceSegmented paper />
        <AppearanceSegmented paper />
      </>
    );
    const [a, b] = screen.getAllByRole('radiogroup', { name: 'Appearance' });
    fireEvent.click(within(a).getByRole('radio', { name: 'System' }));
    expect(within(b).getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    act(() => {
      localStorage.setItem('ds.theme.v1', 'dark');
      window.dispatchEvent(new StorageEvent('storage', { key: 'ds.theme.v1' }));
    });
    expect(within(a).getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    expect(root.classList.contains('dark')).toBe(true);
  });
});

describe('AppearanceButton', () => {
  it('names the current look and shows its icon; the ds IconButton keeps the 44 px coarse floor', () => {
    render(<AppearanceButton paper />);
    const button = screen.getByRole('button', { name: 'Appearance: Light' });
    expect(button).toHaveAttribute('data-slot', 'icon-button');
    expect(button.className).toMatch(/(?:^|\s)coarse:min-h-\[var\(--ds-density-touch\)\]/);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('opens a panel with the four choices, focus on the checked one; choosing relabels the button', () => {
    render(<AppearanceButton paper />);
    const button = screen.getByRole('button', { name: 'Appearance: Light' });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(button.getAttribute('aria-controls') || '') as HTMLElement;
    expect(panel).not.toBeNull();
    const group = within(panel).getByRole('radiogroup', { name: 'Appearance' });
    expect(radios(group)).toEqual(['Light', 'Dark', 'Paper', 'System']);
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: 'Light' }));
    fireEvent.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect(root.classList.contains('dark')).toBe(true);
    expect(screen.getByRole('button', { name: 'Appearance: Dark' })).toBe(button);
  });

  it('Esc closes the panel and returns focus to the button; a press outside closes it too', () => {
    render(
      <div>
        <AppearanceButton paper />
        <p>Outside</p>
      </div>
    );
    const button = screen.getByRole('button', { name: /^Appearance: / });
    fireEvent.click(button);
    expect(screen.getByRole('radiogroup', { name: 'Appearance' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('radiogroup', { name: 'Appearance' })).toBeNull();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(screen.getByRole('radiogroup', { name: 'Appearance' })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText('Outside'));
    expect(screen.queryByRole('radiogroup', { name: 'Appearance' })).toBeNull();
  });

  it('placement classes go on the wrapper, so a hidden button leaves no empty flex item behind; className stays on the button', () => {
    render(<AppearanceButton paper className="look" wrapperClassName="place" />);
    const button = screen.getByRole('button', { name: /^Appearance: / });
    expect(button.className.split(/\s+/)).toContain('look');
    expect((button.parentElement as HTMLElement).className.split(/\s+/)).toContain('place');
  });

  it('reports open and closed to its host (onOpenChange)', () => {
    const changes: boolean[] = [];
    render(<AppearanceButton paper onOpenChange={(o) => changes.push(o)} />);
    const button = screen.getByRole('button', { name: /^Appearance: / });
    fireEvent.click(button);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(changes).toEqual([true, false]);
  });

  it('without paper the panel offers three choices', () => {
    render(<AppearanceButton />);
    fireEvent.click(screen.getByRole('button', { name: /^Appearance: / }));
    expect(radios(screen.getByRole('radiogroup', { name: 'Appearance' }))).toEqual(['Light', 'Dark', 'System']);
  });

  it('shows no money anywhere', () => {
    const { container } = render(
      <>
        <AppearanceButton paper />
        <AppearanceSegmented paper />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: /^Appearance: / }));
    expect(container.textContent ?? '').not.toMatch(/\$|cents?\b|¢/i);
  });
});
