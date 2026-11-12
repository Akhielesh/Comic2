// NumberField (PE-INSPECT; agent-editor plan §4 Wave 1 C-INSPECT): a typed value commits ONE op, arrows step and
// Shift steps ×10, values clamp to the range, Escape puts the value back, and the field never feeds the editor's keys.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NumberField, clampTo, parseNumberText, roundTo, stepValue } from './NumberField';

const field = (extra: Partial<React.ComponentProps<typeof NumberField>> = {}) => {
  const onCommit = vi.fn();
  render(<NumberField label="X" value={0.5} scale={100} min={0} max={100} step={1} unit="%" onCommit={onCommit} {...extra} />);
  return { onCommit, input: screen.getByRole('spinbutton', { name: 'X' }) as HTMLInputElement };
};

describe('NumberField', () => {
  it('a typed value commits one op on Enter (stored units), and leaving the field does not commit it again', () => {
    const { onCommit, input } = field();
    expect(input.value).toBe('50');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '40' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(0.4, { via: 'type' });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('leaving the field commits a typed value once; an unchanged value commits nothing', () => {
    const { onCommit, input } = field();
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '62' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(0.62, { via: 'type' });
  });

  it('arrow keys step by the step, Shift steps ×10, each a "step" commit (callers coalesce them)', () => {
    const { onCommit, input } = field();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenLastCalledWith(0.51, { via: 'step' });
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(0.61, { via: 'step' });
    fireEvent.keyDown(input, { key: 'ArrowDown', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(0.51, { via: 'step' });
    expect(onCommit).toHaveBeenCalledTimes(3);
  });

  it('values clamp to the range (typed and stepped)', () => {
    const { onCommit, input } = field({ value: 0.98 });
    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith(1, { via: 'type' });
    fireEvent.change(input, { target: { value: '-20' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith(0, { via: 'type' });
    expect(stepValue(98, 1, 1, true, 0, 100)).toBe(100);
    expect(stepValue(3, -1, 1, true, 0, 100)).toBe(0);
  });

  it('Escape puts the value back and commits nothing; text that is not a number commits nothing', () => {
    const { onCommit, input } = field();
    fireEvent.change(input, { target: { value: '70' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('50');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('50');
  });

  it('a mixed selection shows "Mixed": the arrows wait for a typed value, which then commits', () => {
    const { onCommit, input } = field({ value: undefined });
    expect(input.placeholder).toBe('Mixed');
    expect(input.getAttribute('aria-valuetext')).toBe('Mixed');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(0.3, { via: 'type' });
  });

  it('keys typed in the field never reach the editor (no balloon nudge, no page turn, no tool)', () => {
    const outer = vi.fn();
    const onCommit = vi.fn();
    render(
      <div onKeyDown={outer}>
        <NumberField label="Size" value={1} scale={100} min={50} max={350} step={5} onCommit={onCommit} />
      </div>
    );
    const input = screen.getByRole('spinbutton', { name: 'Size' });
    for (const key of ['ArrowLeft', 'ArrowUp', '5', 'Delete', 'Enter']) fireEvent.keyDown(input, { key });
    expect(outer).not.toHaveBeenCalled();
  });

  it('the − / + steppers step, and are 44 px targets on touch; the input opens the number keypad', () => {
    const { onCommit, input } = field();
    const plus = screen.getByRole('button', { name: 'Increase x' });
    const minus = screen.getByRole('button', { name: 'Decrease x' });
    fireEvent.click(plus);
    expect(onCommit).toHaveBeenLastCalledWith(0.51, { via: 'step' });
    fireEvent.click(minus);
    expect(onCommit).toHaveBeenLastCalledWith(0.5, { via: 'step' });
    for (const b of [plus, minus]) {
      expect(b.className).toContain('coarse:min-h-11');
      expect(b.className).toContain('coarse:min-w-11');
    }
    expect(input.className).toContain('coarse:h-11');
    expect(input.getAttribute('inputmode')).toBe('decimal');
  });

  it('parses what people type: units, a decimal comma, a typographic minus', () => {
    expect(parseNumberText('40')).toBe(40);
    expect(parseNumberText(' 40 % ')).toBe(40);
    expect(parseNumberText('15°')).toBe(15);
    expect(parseNumberText('1,5')).toBe(1.5);
    expect(parseNumberText('−12')).toBe(-12);
    expect(parseNumberText('+3')).toBe(3);
    expect(parseNumberText('.5')).toBe(0.5);
    expect(parseNumberText('3 mm')).toBe(3);
    for (const bad of ['', 'abc', '1.2.3', '--4', '4-']) expect(parseNumberText(bad)).toBeUndefined();
    expect(clampTo(Number.NaN, 2, 9)).toBe(2);
    expect(roundTo(-0.0001, 2)).toBe(0);
  });
});
