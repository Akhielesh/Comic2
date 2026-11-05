/**
 * Input and Textarea — Atlas `ui-generated/input.tsx` / `textarea.tsx` on the FIELD recipe: the 3:1
 * control edge (darker on hover), focus drawn as a 2 px ring 2 px off (so a field embedded in a group can
 * drop it), the danger edge while `aria-invalid`. 16 px text on phones (iOS zooms into anything smaller),
 * the 14 px body size from `md` up; at least 44 px tall under a coarse pointer. Inside a Field they take its id,
 * description, error and required / disabled state.
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { useFieldControl } from './Field';
import { DENSITY, FIELD } from './recipes';

const FIELD_TYPE = 'text-base md:text-[length:var(--ds-text-base)] aria-[invalid=true]:border-[var(--ds-danger-mark)]';

export const INPUT_CLASSES = `${FIELD} ${FIELD_TYPE} flex h-10 w-full min-w-0 px-3 py-2 file:border-0 file:bg-transparent file:text-[length:var(--ds-text-base)] file:font-medium ${DENSITY.coarse}`;
/** At least 64 px tall, so it clears the 44 px touch floor without the coarse rule (which would lower its minimum). */
export const TEXTAREA_CLASSES = `${FIELD} ${FIELD_TYPE} flex min-h-16 w-full min-w-0 resize-none px-3 py-2`;

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({ className, type, ...props }, ref) {
  const wired = useFieldControl(props);
  return <input {...wired} ref={ref} type={type ?? 'text'} data-slot="input" className={cn(INPUT_CLASSES, className)} />;
});

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...props }, ref) {
  const wired = useFieldControl(props);
  return <textarea {...wired} ref={ref} data-slot="textarea" className={cn(TEXTAREA_CLASSES, className)} />;
});
