// shadcn-style class utility. `cn` merges conditional class lists (clsx) and resolves
// conflicting Tailwind classes (tailwind-merge) so later classes win. Used with
// class-variance-authority by the connector UI kit (components/connectors/ui.tsx) and by every
// primitive in components/ds.

import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge, validators } from 'tailwind-merge';

/**
 * tailwind-merge 3 follows Tailwind 4, where a bare `outline` is an outline WIDTH. This app runs Tailwind 3.4,
 * where `outline` is the solid outline STYLE, so the stock merge read `focus-visible:outline
 * focus-visible:outline-2` as two widths and dropped the first: cn(FOCUS_RING) lost its outline style and the
 * focus ring disappeared. Here the widths are numbers and arbitrary lengths only, and a bare `outline` joins
 * the style group (lib/utils.test.ts).
 */
const twMerge = extendTailwindMerge({
  override: {
    classGroups: {
      'outline-w': [{ outline: [validators.isNumber, validators.isArbitraryLength, validators.isArbitraryVariableLength] }],
      'outline-style': ['outline', { outline: ['dashed', 'dotted', 'double', 'none', 'hidden'] }]
    }
  }
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
