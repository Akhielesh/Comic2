// The phone toolbar (PE-SHELL): DC-0 #10 — the buttons size to their labels (no flex-1 squeeze), so "Mark up" and
// "Lettering" read in full at 320 px (measured in Chromium by tests/e2e/editor.proshell.spec.ts); and the Pro Layers
// button (C9) exists only when the shell passes it.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorToolbar } from './EditorToolbar';

afterEach(cleanup);

const bar = (layers?: { open: boolean; onToggle(): void }) =>
  render(
    <EditorToolbar
      orientation="horizontal"
      mode="move"
      onModeChange={() => undefined}
      canUndo
      canRedo
      onUndo={() => undefined}
      onRedo={() => undefined}
      lettering={{ open: false, onToggle: () => undefined }}
      tools={{ open: false, onToggle: () => undefined }}
      layers={layers}
    />
  );

describe('EditorToolbar labels (DC-0 #10)', () => {
  it('every bar button takes its label’s width (flex-auto), never an equal flex-1 share', () => {
    bar();
    for (const name of ['Move', 'Mark up', 'Undo', 'Redo', 'Lettering', 'Page tools']) {
      const b = screen.getByRole(name === 'Move' || name === 'Mark up' ? 'radio' : 'button', { name });
      expect(b.className).toMatch(/\bflex-auto\b/);
      expect(b.className).not.toMatch(/\bflex-1\b/);
      expect(b.className).toMatch(/min-w-\[44px\]/);
    }
    expect(screen.getByRole('radiogroup', { name: 'Editing mode' }).className).not.toMatch(/flex-\[2\]/);
  });
});

describe('the Pro Layers button (C9)', () => {
  it('is absent without the prop and toggles the sheet with it', () => {
    bar();
    expect(screen.queryByTestId('toolbar-layers')).toBeNull();
    cleanup();
    const onToggle = vi.fn();
    bar({ open: false, onToggle });
    const b = screen.getByRole('button', { name: 'Layers' });
    expect(b).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(b);
    expect(onToggle).toHaveBeenCalled();
  });
});
