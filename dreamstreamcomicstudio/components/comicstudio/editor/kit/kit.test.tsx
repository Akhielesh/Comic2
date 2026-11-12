// The Pro editor kit (PE-SHELL): ToolButton, PropertyRow, ScrubField, SliderField, SwatchPopover, PresetCard and the
// stacking recipe, on components/ds and the studio recipes, every control 44 px under a coarse pointer.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SEGMENTED_ACTIVE, Z } from '../../../chat/studioDesign';
import { EDITOR_Z, PresetCard, PropertyRow, ScrubField, SliderField, SwatchPopover, ToolButton, clampToStep, editorZ, normalizeHex, parseNumber, part } from './index';

afterEach(cleanup);

const COARSE = /coarse:min-h-\[var\(--ds-density-touch\)\]/;

describe('the kit part', () => {
  it('is ready (the shell builds on it)', () => {
    expect(part).toEqual({ id: 'kit', ready: true });
  });
});

describe('ToolButton', () => {
  it('pressed = SEGMENTED_ACTIVE (never a hue), its key in aria-keyshortcuts and the tooltip, 44 px coarse', () => {
    render(<ToolButton label="Balloon" shortcut="B" icon={<span />} active onClick={() => undefined} />);
    const b = screen.getByRole('button', { name: 'Balloon' });
    expect(b).toHaveAttribute('aria-pressed', 'true');
    expect(b.getAttribute('title')).toBe('Balloon (B)');
    for (const token of SEGMENTED_ACTIVE.split(' ')) expect(b.className).toContain(token);
    expect(b.className).toMatch(COARSE);
  });
  it('an off tool explains itself and ignores the click', () => {
    const onClick = vi.fn();
    render(<ToolButton label="Text" icon={<span />} disabledReason="Not here" onClick={onClick} />);
    const b = screen.getByRole('button', { name: 'Text' });
    expect(b).toHaveAccessibleDescription('Not here');
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('PropertyRow', () => {
  it('is a labelled group with its hint as a description', () => {
    render(
      <PropertyRow label="Rotation" hint="±45°">
        <input aria-label="deg" />
      </PropertyRow>
    );
    const g = screen.getByRole('group', { name: 'Rotation' });
    expect(g).toHaveAccessibleDescription('±45°');
    expect(g.className).toMatch(/coarse:min-h/);
  });
});

describe('ScrubField', () => {
  it('helpers: clamp to the step; parse "12°" / "-7,5"', () => {
    expect(clampToStep(37, -45, 45, 15)).toBe(30);
    expect(clampToStep(99, -45, 45, 15)).toBe(45);
    expect(clampToStep(0.123, 0, 1, 0.01)).toBe(0.12);
    expect(parseNumber('12°')).toBe(12);
    expect(parseNumber('-7,5')).toBe(-7.5);
    expect(parseNumber('abc')).toBeNull();
  });
  it('Enter commits ONE clamped value; arrows step (Shift ×10); a bad entry reverts', () => {
    const onCommit = vi.fn();
    render(<ScrubField label="Rotation" value={0} min={-45} max={45} step={1} unit="°" onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton', { name: 'Rotation' });
    fireEvent.change(input, { target: { value: '120' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(45);
    cleanup();
    render(<ScrubField label="Rotation" value={0} min={-45} max={45} step={1} unit="°" onCommit={onCommit} />);
    const input2 = screen.getByRole('spinbutton', { name: 'Rotation' });
    fireEvent.keyDown(input2, { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenLastCalledWith(1);
    cleanup();
    render(<ScrubField label="Rotation" value={0} min={-45} max={45} step={1} unit="°" onCommit={onCommit} />);
    const input3 = screen.getByRole('spinbutton', { name: 'Rotation' });
    fireEvent.keyDown(input3, { key: 'ArrowDown', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(-10);
    onCommit.mockClear();
    cleanup();
    render(<ScrubField label="Rotation" value={0} min={-45} max={45} step={1} unit="°" onCommit={onCommit} />);
    const input4 = screen.getByRole('spinbutton', { name: 'Rotation' });
    fireEvent.change(input4, { target: { value: 'nope' } });
    fireEvent.keyDown(input4, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect((input4 as HTMLInputElement).value).toBe('0');
    expect(input4.className).toMatch(COARSE);
  });
  it('a scrub previews live and commits once on release; a second pointer cancels it', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<ScrubField label="Size" value={10} min={0} max={100} step={1} onChange={onChange} onCommit={onCommit} />);
    const handle = screen.getByTestId('scrub-handle');
    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 40, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(20);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { clientX: 40, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(20);
    onCommit.mockClear();
    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 3, button: 0, pointerType: 'touch' });
    fireEvent.pointerMove(window, { clientX: 40, pointerId: 3 });
    fireEvent.pointerMove(window, { clientX: 41, pointerId: 4 });
    fireEvent.pointerUp(window, { clientX: 40, pointerId: 3 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith(10);
  });
});

describe('SliderField', () => {
  it('follows the value live and commits once when the gesture ends', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<SliderField label="Opacity" value={50} min={0} max={100} unit="%" onChange={onChange} onCommit={onCommit} />);
    const slider = screen.getByRole('slider', { name: 'Opacity' });
    fireEvent.change(slider, { target: { value: '60' } });
    fireEvent.change(slider, { target: { value: '70' } });
    expect(onChange).toHaveBeenLastCalledWith(70);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(70);
    expect(slider).toHaveAttribute('aria-valuetext', '70%');
  });
});

describe('SwatchPopover', () => {
  it('opens, picks a swatch, closes and returns focus; a typed hex works; Esc closes', () => {
    const onPick = vi.fn();
    render(<SwatchPopover label="Fill" value="#ffffff" swatches={['#ffffff', '#111111']} onPick={onPick} />);
    const well = screen.getByRole('button', { name: 'Fill: #ffffff' });
    expect(well.className).toMatch(/coarse:min-w/);
    fireEvent.click(well);
    expect(well).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: '#111111' }));
    expect(onPick).toHaveBeenCalledWith('#111111');
    expect(screen.queryByTestId('swatch-panel')).toBeNull();
    expect(document.activeElement).toBe(well);
    fireEvent.click(well);
    const hex = screen.getByRole('textbox');
    fireEvent.change(hex, { target: { value: 'FF0000' } });
    fireEvent.keyDown(hex, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('#ff0000');
    fireEvent.click(well);
    fireEvent.keyDown(screen.getByTestId('swatch-panel'), { key: 'Escape' });
    expect(screen.queryByTestId('swatch-panel')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('#11223344')).toBe('#11223344');
  });
});

describe('PresetCard', () => {
  it('a pressed card with its name and "Free"; 44 px coarse', () => {
    render(<PresetCard name="Pop in" selected onClick={() => undefined} />);
    const b = screen.getByRole('button', { name: /Pop in/ });
    expect(b).toHaveAttribute('aria-pressed', 'true');
    expect(b.textContent).toContain('Free');
    expect(b.className).toMatch(COARSE);
  });
});

describe('zLayers', () => {
  it('maps every editor layer onto the Z ladder (no numbers)', () => {
    expect(EDITOR_Z.editor).toBe(Z.editor);
    expect(editorZ('popover')).toBe(Z.popover);
    for (const cls of Object.values(EDITOR_Z)) expect(cls).toMatch(/^z-\[var\(--ds-z-/);
  });
});
