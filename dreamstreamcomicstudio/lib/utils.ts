// shadcn-style class utility. `cn` merges conditional class lists (clsx) and resolves
// conflicting Tailwind classes (tailwind-merge) so later classes win. Used with
// class-variance-authority by the connector UI kit (components/connectors/ui.tsx).

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
