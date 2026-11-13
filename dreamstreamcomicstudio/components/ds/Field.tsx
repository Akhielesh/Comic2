/**
 * Field — a label, the control, a description and an error, wired together (Atlas Label + the form
 * message pattern). The control inside (Input, Textarea, Select, Checkbox, Switch, Slider) picks up the
 * field's id, `aria-describedby` (the error first, then the description), `aria-invalid` while there is
 * an error, and `required` / `disabled`, through `useFieldControl` — so a screen reader hears the label,
 * the help and the problem, and the label click focuses the control.
 *
 * The error is always paired with an icon and reads the readable danger ink (TONE_TEXT.danger), never
 * colour alone. Focus the first invalid field on submit; the field itself does not announce.
 *
 * Disabled dims the label only (the label of a disabled control, which contrast rules exempt) and the
 * control itself (its own `disabled:opacity-50`); the description and the error keep their full ink, so
 * the help that says why it is locked stays readable (4.5:1).
 */
import React, { createContext, useContext, useId } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { TONE_TEXT, WRAP_TEXT } from './recipes';

export interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required?: boolean;
  disabled?: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** The field a control sits in (null outside a Field). */
export const useField = (): FieldContextValue | null => useContext(FieldContext);

export interface FieldControlProps {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: React.AriaAttributes['aria-invalid'];
  required?: boolean;
  disabled?: boolean;
}

/** A control's props with the enclosing Field's wiring merged in (its own props win; descriptions join). */
export function useFieldControl<T extends FieldControlProps>(props: T): T {
  const field = useContext(FieldContext);
  if (!field) return props;
  const describedBy = [field.describedBy, props['aria-describedby']].filter(Boolean).join(' ') || undefined;
  return {
    ...props,
    id: props.id ?? field.id,
    'aria-describedby': describedBy,
    'aria-invalid': props['aria-invalid'] ?? (field.invalid ? true : undefined),
    required: props.required ?? field.required,
    disabled: props.disabled ?? field.disabled
  };
}

export const FIELD_LABEL = 'text-[length:var(--ds-text-base)] font-medium leading-5 text-[var(--ds-ink)]';
export const FIELD_DESCRIPTION = `m-0 text-pretty text-[length:var(--ds-text-sm)] leading-5 text-[var(--ds-muted)] ${WRAP_TEXT}`;
export const FIELD_ERROR = `m-0 flex items-start gap-1.5 text-[length:var(--ds-text-sm)] font-medium leading-5 ${TONE_TEXT.danger}`;

export interface FieldProps {
  /** The visible label; it names the control. */
  label: React.ReactNode;
  /** Help text under the control, part of its description. */
  description?: React.ReactNode;
  /** What is wrong and how to fix it: marks the control invalid and leads its description. */
  error?: React.ReactNode;
  /** The control's id (generated when omitted). */
  id?: string;
  required?: boolean;
  disabled?: boolean;
  /** Keep the label for assistive tech only (a search box whose icon and placeholder already say it). */
  hideLabel?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function Field({ label, description, error, id, required, disabled, hideLabel = false, className, children }: FieldProps) {
  const generated = useId();
  const controlId = id ?? `field-${generated.replace(/:/g, '')}`;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [errorId, descriptionId].filter(Boolean).join(' ') || undefined;
  const value: FieldContextValue = { id: controlId, describedBy, invalid: Boolean(error), required, disabled };
  return (
    <div data-slot="field" data-invalid={error ? '' : undefined} className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={controlId} className={cn(FIELD_LABEL, disabled && 'opacity-70', hideLabel && 'sr-only')}>
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-0.5">
            *
          </span>
        ) : null}
      </label>
      <FieldContext.Provider value={value}>{children}</FieldContext.Provider>
      {description ? (
        <p id={descriptionId} data-slot="field-description" className={FIELD_DESCRIPTION}>
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} data-slot="field-error" className={FIELD_ERROR}>
          <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span className={WRAP_TEXT}>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
