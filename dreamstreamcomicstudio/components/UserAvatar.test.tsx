// UserAvatar on the Atlas tokens (DS-2 #6): no comic chrome, the signed-in dot on the success mark, and a real,
// named button only when it does something (a comment's avatar opens the profile, from the keyboard too).

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../services/db', () => ({ getUserProfile: vi.fn(async () => ({ avatar_url: 'https://cdn.example/me.png' })) }));

import { UserAvatar } from './UserAvatar';

const LEGACY = /^(?:[\w-]+:)*(?:border-black|shadow-comic|font-comic|font-display|(?:bg|text|border)-slate-\d+|bg-green-\d+|border-white)/;
const classesIn = (root: Element) => [root, ...root.querySelectorAll('*')].flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/)).filter(Boolean);

afterEach(() => {
  auth.user = null;
});

describe('UserAvatar', () => {
  it('draws the initial on the well with no comic chrome, and is not a control without onClick', () => {
    const { container } = render(<UserAvatar url={null} name="mira" size="sm" />);
    expect(screen.getByText('M')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(classesIn(container.firstElementChild!).filter((c) => LEGACY.test(c))).toEqual([]);
    expect(container.querySelector('.bg-\\[var\\(--ds-well\\)\\]')).not.toBeNull();
  });

  it('with onClick it is a button named by the person, reachable from the keyboard', () => {
    const onClick = vi.fn();
    render(<UserAvatar url={null} name="mira" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'mira' });
    expect(button).toHaveAttribute('type', 'button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('the current user’s own avatar shows their picture and the signed-in dot on the success mark', async () => {
    auth.user = { id: 'u1', email: 'reader@example.com' };
    const { container } = render(<UserAvatar />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'reader@example.com' })).toHaveAttribute('src', 'https://cdn.example/me.png'));
    const dot = container.querySelector('[aria-hidden].bg-\\[var\\(--ds-success\\)\\]');
    expect(dot).not.toBeNull();
    expect(classesIn(container.firstElementChild!).filter((c) => LEGACY.test(c))).toEqual([]);
  });
});
