// "Who's in this photo?" — the quick-assign menu's structure and keyboard behaviour (P2-CONVERSATION
// review). axe runs on the real DOM in both steps (the list and "New character…" naming) with the
// structural rules on; colour contrast needs a real browser (P1-QA harness).

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { AssignMenu } from './AssignMenu';
import { makeSampleDoc } from './testing/fixtures';

const axeViolations = async (el: HTMLElement) => {
  const res = await axe.run(el, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } }
  });
  return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.failureSummary).join(' | ')}`);
};

describe('AssignMenu', () => {
  it('passes axe in the list and in the naming step (the name field never sits inside role="menu")', async () => {
    const { container } = render(<AssignMenu doc={makeSampleDoc()} count={2} onPick={() => undefined} allowClear />);
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(within(screen.getByRole('menu', { name: "Who's in these 2 photos?" })).getByRole('menuitem', { name: /New character/ }));
    const field = screen.getByLabelText("New character's name");
    expect(field).toHaveFocus();
    expect(field.closest('[role="menu"]')).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('naming: Add files the photos under the new name (trimmed); Back returns to the list unchanged', () => {
    const onPick = vi.fn();
    render(<AssignMenu doc={makeSampleDoc()} count={1} onPick={onPick} />);
    fireEvent.click(screen.getByRole('menuitem', { name: /New character/ }));
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the cast' }));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: /New character/ }));
    // A fresh field: the abandoned draft is not carried over.
    expect(screen.getByLabelText("New character's name")).toHaveValue('');
    fireEvent.change(screen.getByLabelText("New character's name"), { target: { value: '  Bruno   the  Dog ' } });
    fireEvent.submit(screen.getByLabelText("New character's name").closest('form')!);
    expect(onPick).toHaveBeenCalledWith({ kind: 'new_character', name: 'Bruno the Dog' });
  });

  it('arrow keys, Home and End move between the enabled rows', () => {
    render(<AssignMenu doc={makeSampleDoc()} count={1} onPick={() => undefined} allowClear />);
    const menu = screen.getByRole('menu');
    const rows = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')).filter((r) => !r.disabled);
    expect(rows.length).toBeGreaterThan(3);
    rows[0].focus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(rows[rows.length - 1]).toHaveFocus(); // wraps
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(rows[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(rows[rows.length - 1]).toHaveFocus();
    expect(rows[rows.length - 1]).toHaveAccessibleName(/Let the director decide/);
  });
});
