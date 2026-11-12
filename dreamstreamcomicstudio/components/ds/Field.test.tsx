import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cn } from '../../lib/utils';
import { Field, FIELD_ERROR } from './Field';
import { Input, INPUT_CLASSES, Textarea, TEXTAREA_CLASSES } from './Input';
import { Select, SELECT_CLASSES, SELECT_SIZE } from './Select';
import { Checkbox } from './Checkbox';
import { Switch } from './Switch';
import { FIELD, TONE_TEXT } from './recipes';
import { expectClasses } from './ds.testkit';

describe('Field — label, description and error wired to the control', () => {
  it('names the control, describes it (error first, then help) and marks it invalid while there is an error', () => {
    const { rerender } = render(
      <Field label="Comic title" description="Shown on the cover and in the gallery." id="title">
        <Input defaultValue="Lake" />
      </Field>
    );
    const input = screen.getByLabelText('Comic title');
    expect(input).toHaveAttribute('id', 'title');
    expect(input).toHaveAttribute('aria-describedby', 'title-description');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText('Shown on the cover and in the gallery.')).toHaveAttribute('id', 'title-description');
    expect(input).toHaveAccessibleDescription('Shown on the cover and in the gallery.');

    rerender(
      <Field label="Comic title" description="Shown on the cover and in the gallery." error="Give the comic a title." id="title">
        <Input defaultValue="" />
      </Field>
    );
    const invalid = screen.getByLabelText('Comic title');
    expect(invalid).toHaveAttribute('aria-invalid', 'true');
    expect(invalid).toHaveAttribute('aria-describedby', 'title-error title-description');
    expect(invalid).toHaveAccessibleDescription('Give the comic a title. Shown on the cover and in the gallery.');
    // The error reads the readable danger ink and is paired with an icon, never colour alone.
    const error = document.getElementById('title-error')!;
    expectClasses(error, FIELD_ERROR, TONE_TEXT.danger);
    expect(error.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(error).toHaveTextContent('Give the comic a title.');
  });

  it('generates an id when none is given, and keeps a control’s own description after the field’s', () => {
    render(
      <>
        <span id="extra">Counts toward your usage.</span>
        <Field label="Prompt" description="What happens on this page.">
          <Textarea aria-describedby="extra" />
        </Field>
      </>
    );
    const ta = screen.getByLabelText('Prompt');
    expect(ta.id).toMatch(/^field-/);
    expect(ta.getAttribute('aria-describedby')).toBe(`${ta.id}-description extra`);
  });

  it('passes required and disabled to the control; the required star is decoration', () => {
    render(
      <Field label="Email" required disabled>
        <Input type="email" />
      </Field>
    );
    const input = screen.getByRole('textbox', { name: 'Email' });
    expect(input).toBeRequired();
    expect(input).toBeDisabled();
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
  });

  it('disabled dims the label and the control once, never the description (it stays 4.5:1)', () => {
    render(
      <Field label="Disabled field" disabled description="Locked while the page draws." error="Finish the draft first." id="locked">
        <Input />
      </Field>
    );
    const input = screen.getByLabelText('Disabled field');
    expect(input).toBeDisabled();
    const root = input.closest('[data-slot="field"]')!;
    const opacity = (el: Element) => [...el.classList].filter((c) => /(^|:)opacity-/.test(c));
    const chain = (from: Element) => {
      const els: Element[] = [];
      for (let el: Element | null = from; el; el = el.parentElement) {
        els.push(el);
        if (el === root) break;
      }
      return els;
    };
    for (const id of ['locked-description', 'locked-error']) {
      expect(chain(document.getElementById(id)!).flatMap(opacity), id).toEqual([]);
    }
    // The control dims itself (disabled:opacity-50) and nothing above it adds a second step.
    expect(chain(input).flatMap(opacity)).toEqual(['disabled:opacity-50']);
    expect(opacity(screen.getByText('Disabled field'))).toEqual(['opacity-70']);
  });

  it('a hidden label still names the control', () => {
    render(
      <Field label="Search comics" hideLabel>
        <Input type="search" placeholder="Search" />
      </Field>
    );
    expect(screen.getByLabelText('Search comics')).toBeInTheDocument();
    expect(screen.getByText('Search comics')).toHaveClass('sr-only');
  });

  it('wires Select, Checkbox and Switch the same way', () => {
    render(
      <>
        <Field label="Page size" error="Pick a size.">
          <Select options={[{ value: 'a4', label: 'A4' }]} placeholder="Choose…" />
        </Field>
        <Field label="Show page numbers" description="In the reader and the PDF.">
          <Checkbox />
        </Field>
        <Field label="Autosave" description="Every change is kept.">
          <Switch />
        </Field>
      </>
    );
    const select = screen.getByLabelText('Page size');
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAccessibleDescription('Pick a size.');
    expect(screen.getByLabelText('Show page numbers')).toHaveAccessibleDescription('In the reader and the PDF.');
    expect(screen.getByRole('switch', { name: 'Autosave' })).toHaveAccessibleDescription('Every change is kept.');
  });
});

describe('Input, Textarea, Select — the FIELD recipe', () => {
  it('Input: the 3:1 edge, the focus ring, the danger edge when invalid, 16 px on phones', () => {
    render(<Input aria-label="Name" />);
    const input = screen.getByLabelText('Name');
    expectClasses(input, INPUT_CLASSES, FIELD);
    expect(input).toHaveAttribute('type', 'text');
    expect(INPUT_CLASSES).toContain('aria-[invalid=true]:border-[var(--ds-danger-mark)]');
    expect(INPUT_CLASSES).toContain('text-base md:text-[length:var(--ds-text-base)]');
    expect(INPUT_CLASSES.split(' ')).toContain('h-10'); // Atlas input height
  });

  it('Textarea: the same recipe, at least 64 px tall, Atlas’s fixed size', () => {
    render(<Textarea aria-label="Notes" />);
    expectClasses(screen.getByLabelText('Notes'), TEXTAREA_CLASSES, FIELD);
    expect(TEXTAREA_CLASSES.split(' ')).toEqual(expect.arrayContaining(['min-h-16', 'resize-none']));
  });

  it('Select: a native select on the recipe with Atlas’s sizes and a decorative chevron', () => {
    const onChange = vi.fn();
    render(<Select aria-label="Format" size="sm" options={[{ value: 'pdf', label: 'PDF' }, { value: 'png', label: 'PNG' }]} onChange={onChange} />);
    const select = screen.getByRole('combobox', { name: 'Format' });
    expectClasses(select, cn(SELECT_CLASSES, SELECT_SIZE.sm), FIELD);
    expect(SELECT_SIZE).toEqual({ sm: 'h-8', default: 'h-9' });
    expect(select.parentElement!.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.change(select, { target: { value: 'png' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('Select placeholder: a disabled first option in the muted ink until something is chosen', () => {
    render(<Select aria-label="Style" placeholder="Pick a style" options={[{ value: 'ink', label: 'Ink' }]} />);
    const select = screen.getByRole('combobox', { name: 'Style' }) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByRole('option', { name: 'Pick a style' })).toBeDisabled();
    expect(select).toHaveAttribute('data-placeholder');
    fireEvent.change(select, { target: { value: 'ink' } });
    expect(select).not.toHaveAttribute('data-placeholder');
  });
});
