import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Avatar, AVATAR_TONES, LinkBox, avatarTone, gradFor, redactUrlSearchParams } from './primitives';

describe('Stream Studio LinkBox host-key safety', () => {
  it('redacts host and guest capability query or fragment parameters without hiding the event id', () => {
    const legacy = redactUrlSearchParams('https://comic2.pages.dev/live.html?e=evt_123&k=host_secret_abc#studio');
    const fragment = redactUrlSearchParams('https://comic2.pages.dev/live.html?e=evt_123#/studio?k=host_secret_abc');
    const guestFragment = redactUrlSearchParams('https://comic2.pages.dev/live.html?e=evt_123#/guest?g=guest_secret_abc');

    expect(legacy).toContain('e=evt_123');
    expect(legacy).toContain('k=••••••');
    expect(legacy).not.toContain('host_secret_abc');
    expect(fragment).toContain('e=evt_123');
    expect(fragment).toContain('#/studio?k=••••••');
    expect(fragment).not.toContain('host_secret_abc');
    expect(guestFragment).toContain('e=evt_123');
    expect(guestFragment).toContain('#/guest?g=••••••');
    expect(guestFragment).not.toContain('guest_secret_abc');
  });

  it('auto-redacts warned private links when a display URL is not supplied', () => {
    render(
      <LinkBox
        url="https://comic2.pages.dev/live.html?e=evt_123#/studio?k=host_secret_abc"
        copyWarning="This link controls the event."
      />,
    );

    expect(screen.getByText(/k=••••••/)).toBeInTheDocument();
    expect(screen.queryByText(/host_secret_abc/)).toBeNull();
  });

  it('requires a second click before copying a warned private link', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const onCopy = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <LinkBox
        url="https://comic2.pages.dev/live.html?e=evt_123#/studio?k=host_secret_abc"
        displayUrl="https://comic2.pages.dev/live.html?e=evt_123#/studio?k=••••••"
        copyLabel="Copy private link"
        copyWarning="This link controls the event."
        onCopy={onCopy}
      />,
    );

    expect(screen.getByText(/k=••••••/)).toBeInTheDocument();
    expect(screen.queryByText(/host_secret_abc/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /copy private link/i }));
    expect(writeText).not.toHaveBeenCalled();
    expect(onCopy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /click again/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /click again/i }));
    expect(writeText).toHaveBeenCalledWith('https://comic2.pages.dev/live.html?e=evt_123#/studio?k=host_secret_abc');
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
  });
});

describe('Stream Studio avatars', () => {
  const html = document.documentElement;
  afterEach(() => html.removeAttribute('data-ds-skin'));

  it('keep their per-name gradient without the Atlas skin', () => {
    const { container } = render(<Avatar name="Alex Rivera" />);
    const el = container.querySelector<HTMLElement>('.avatar')!;
    expect(el.style.background).toContain('linear-gradient');
    expect(el.hasAttribute('data-tone')).toBe(false);
    expect(el.textContent).toBe('AR');
  });

  it('are neutral under the Atlas skin: no inline colour, the ink tone for the signed-in person', () => {
    html.setAttribute('data-ds-skin', 'atlas');
    const { container } = render(
      <>
        <Avatar name="Alex Rivera" self />
        <Avatar name="Sam Lee" />
      </>,
    );
    const [self, other] = [...container.querySelectorAll<HTMLElement>('.avatar')];
    expect(self.style.background).toBe('');
    expect(self.getAttribute('data-tone')).toBe('0');
    expect(other.style.background).toBe('');
    expect(other.getAttribute('data-tone')).toBe(String(avatarTone('Sam Lee')));
    // The incoming-call screen's backdrop (gradFor) loses its hue too.
    expect(gradFor('Sam Lee')).not.toMatch(/#(60a5fa|a3e635|f472b6|c084fc|f87171)/i);
  });

  it('spread people over every tone, the same tone for the same name', () => {
    const tones = new Set(['Alex Rivera', 'Sam Lee', 'Jordan Alvarez', 'Priya Nair', 'Mo Chen', 'Ana Ruiz', 'Lee Park'].map(avatarTone));
    expect(tones.size).toBe(AVATAR_TONES);
    expect(avatarTone('Sam Lee')).toBe(avatarTone('Sam Lee'));
  });
});
