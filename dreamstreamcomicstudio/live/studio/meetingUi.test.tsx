import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InviteSheet } from './meetingUi';
import type { GuestLink } from './rtc';

/**
 * The Invite sheet's meeting line (feature doc §4.2–§4.3, rule 1): "free" only for what is
 * direct. A guest relayed through our TURN is said as such, in visible text — not only in a
 * seat's title, which touch devices never show.
 */
const guest = (sid: string, path: GuestLink['path'], state: GuestLink['state'] = 'connected'): GuestLink => ({ sid, name: `Guest ${sid}`, state, cam: null, screen: null, path });
const sheet = (guests: GuestLink[]) =>
  render(<InviteSheet url="https://example.test/j#k" meeting guests={guests} maxGuests={4} onClose={() => undefined} onShare={() => undefined} onCopy={() => undefined} onRotate={() => undefined} />);
const foot = (c: HTMLElement) => c.querySelector('.sheet-foot')?.textContent ?? '';

describe('Invite sheet — how the meeting travels', () => {
  it('every guest direct: direct and free, and the relay caveat in visible text', () => {
    const { container } = sheet([guest('a', 'internet'), guest('b', 'lan')]);
    expect(foot(container)).toContain('Direct between you and your guests — free.');
    expect(foot(container)).toContain('If someone’s network blocks direct video, an encrypted relay carries it for them.');
  });

  it('a guest through our relay: never "direct … free" for the whole meeting', () => {
    const { container } = sheet([guest('a', 'internet'), guest('b', 'internet'), guest('c', 'relay')]);
    expect(foot(container)).not.toContain('Direct between you and your guests — free');
    expect(foot(container)).toContain('Direct for 2 guests — free; 1 through our encrypted relay');
  });

  it('everyone relayed: says the relay, no "free"', () => {
    const { container } = sheet([guest('a', 'relay')]);
    expect(foot(container)).toContain('Through our encrypted relay for your guest');
    expect(foot(container)).not.toMatch(/\bfree\b/);
  });

  it('guests still connecting, path unknown: the plain meeting line', () => {
    const { container } = sheet([guest('a', null, 'connecting')]);
    expect(foot(container)).toContain('Direct between you and your guests — free.');
  });
});

describe('Ready check — the path line is on screen before going live', () => {
  it('shows who carries the broadcast, in visible text, while it counts down (with Cancel)', async () => {
    const { ReadyCheck } = await import('./meetingUi');
    const { container, getByText } = render(
      <ReadyCheck camera="ok" cameraLabel="FaceTime HD" micOk roomOk quality="720p" cost="Your viewers watch through our servers — free for you." phase="counting" count={3} getMicLevel={() => 0} onCancel={() => undefined} onGo={() => undefined} />,
    );
    expect(container.querySelector('.rc-cost')?.textContent).toBe('Your viewers watch through our servers — free for you.');
    expect(getByText('Cancel')).toBeTruthy();
  });
});
