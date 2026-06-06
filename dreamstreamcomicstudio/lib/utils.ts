// shadcn-style class utility. `cn` merges conditional class lists (clsx) and resolves
// conflicting Tailwind classes (tailwind-merge) so later classes win. Introduced for the
// Code Studio design system (21st.dev / shadcn primitives in components/ui/).

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
