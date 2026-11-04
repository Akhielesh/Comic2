/**
 * Test helpers for the components/ds suites (not a test file: no `.test.` in the name). `expectClasses`
 * asserts every class of the given recipe strings is on the element — so a variant that stops rendering
 * its Atlas classes, or a class `cn` (tailwind-merge) silently drops, fails by name.
 */
import { expect } from 'vitest';

export const classesOf = (...recipes: string[]): string[] => recipes.flatMap((r) => r.split(/\s+/)).filter(Boolean);

export function expectClasses(el: Element, ...recipes: string[]): void {
  const missing = classesOf(...recipes).filter((c) => !el.classList.contains(c));
  expect(missing, `missing on <${el.tagName.toLowerCase()} class="${el.getAttribute('class')}">`).toEqual([]);
}
